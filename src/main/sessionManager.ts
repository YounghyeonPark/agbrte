/**
 * SessionManager (DESIGN.md §4, §8, §13).
 *
 * The headless core of the app: it owns session lifecycle, agent admission, the
 * permission gate, and the mapping from a turn's outcome to a session state. The
 * Electron layer is a client of this — nothing here imports Electron, which is
 * both why it is testable and why the same code can run inside a remote agent
 * host later (§6.4).
 *
 * The rule this class exists to protect: **a pause is not a failure** (§4.1). A
 * pending permission, a dead egress tunnel, and a spent quota window all hold
 * state and resume.
 */

import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import {
  byAttentionThenRecency,
  TREE_LIMITS,
  isPaused,
  isTerminal,
  newAgentId,
  newSessionId,
  uuidv7,
  PEER_MESSAGE_MAX_CHARS,
  type OutboundMessage,
  type OutboundPeerMessage,
  type PeerDelivery,
  type PeerMessage,
  type PermissionAsk,
  type PolicyRule,
  type ResultContract,
  type AgentHandle,
  type AgentMessage,
  type AgentRecord,
  type AgentRole,
  type AgentRuntime,
  type AgentSpec,
  type AttentionReason,
  type ChildRef,
  type CreateSessionInput,
  type CompactedHistory,
  type ReasoningRequest,
  type Annotation,
  type ImageBlock,
  type EventOrigin,
  type ExecutionTarget,
  type InboxEntry,
  type InstanceId,
  type AgbrteEvent,
  type PermissionDecision,
  type PermissionRequest,
  type RawTail,
  type RuntimeContext,
  type Session,
  type SessionBudget,
  type SessionState,
  type Sha256,
  type SplitProposal,
  type StopReason,
  type ToolPolicy,
  type UserTurn,
  type AgentId,
  type SessionId,
  type Actor,
  type SessionTool,
  type SkillConfig,
} from '@shared/types/index.js';
import { McpConnection } from './mcp/client.js';
import { truncateToolOutput } from './tools/index.js';
import { SessionStore, type SessionMeta } from './store/sessionStore.js';
import { sessionLayout, workspaceLayout } from './store/layout.js';
import { openWorkspace, peekIdentity } from './store/identity.js';
import { addCost } from '@shared/cost.js';
import { ensureBlob } from './store/blobTransfer.js';
import { compactionSizes, rehydrate } from './store/rehydrate.js';
import { pumpAgent, stopReasonSummary } from './runtime/supervisor.js';
import { groupFor, QuotaScheduler } from './quota.js';
import { RawTailBuffer } from './rawTail.js';
import { loadRawTails, saveRawTail } from './store/rawTailFile.js';
import { TurnSlots } from './concurrency.js';
import { entriesFrom, merge, ReadMarker } from './inbox.js';
import { fitContent } from './content/fit.js';
import { flattenAnnotations, scaleToFit, sizeOf } from './content/pixels.js';
import { captureUrl } from './capture/headless.js';
import { buildBrief, checkResult, reserveForChild } from './store/brief.js';
import {
  createWorktree,
  hasCommits,
  removeWorktree,
  worktreeSupport,
  type Worktree,
} from './worktree.js';
import type { Isolation, RoleRequirements, RuntimeRegistry } from './runtime/registry.js';
import { defaultPolicyForTarget, evaluatePolicy } from './policy/evaluate.js';

export interface NewAgentInput {
  role: AgentRole;
  runtimeId: string;
  model?: AgentSpec['model'];
  auth?: AgentSpec['auth'];
  systemPrompt?: string;
  policy?: ToolPolicy;
  isolation?: Isolation;
  limits?: AgentSpec['limits'];
  requirements?: RoleRequirements;
  /**
   * The seat this one takes over from — how a model is changed mid-session
   * (§4.2).
   *
   * A session holds one agent, so admitting a second is only ever a
   * *replacement*, and the caller has to say which seat it believes is there.
   * By id rather than a `replace: true` flag because several clients may hold
   * one session (§17 Q14): two people changing the model at once would
   * otherwise each retire whatever they found, and the second would silently
   * throw away the first's choice. Naming the seat makes the loser's attempt a
   * refusal that says the seat is already retired.
   */
  replacing?: AgentId;
}

/** What a split needs beyond the brief itself (§4.3). */
export interface SpawnChildInput {
  title: string;
  /** The child's narrow goal. Becomes its `goal`, and the brief's `scope`. */
  scope: string;
  /** Required: without it the child reads widely to re-derive context (§4.3). */
  outOfScope: string[];
  contract: ResultContract;
  acceptance?: string[];
  /** Carved out of the parent's remainder at spawn, never at spend time. */
  tokenCeiling: number;
  memoryRefs?: string[];
  verbatimTurns?: number;
  /** A child may run somewhere else entirely — that is half the point (§4.3). */
  target?: ExecutionTarget;
}

/**
 * This host has no such session **loaded** — which is not the same as no such
 * session (§5.4, §6.4).
 *
 * A session lives in its log and is loaded on demand, so "not in the map" is a
 * statement about this process's memory and nothing else. A **replacement host
 * starts with an empty map**, so every id a client was holding a moment earlier
 * lands here — which is how `hosts.update` turned a perfectly good session into
 * `Error invoking remote method 'agbrte:sessions.snapshot': unknown session …`
 * in front of somebody who had done nothing but press a button.
 *
 * Its own class so a caller can tell that apart from a broken id: the client
 * answers it by resuming the session and asking again, which is the same thing
 * a person clicking "Resume" in the sidebar does. The name crosses the wire in
 * the protocol's `err.name`, so a client can recognise it without matching on a
 * sentence — and hosts predating this class say the same thing in the same
 * words, which is why the client checks both.
 */
export class UnknownSession extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`unknown session ${sessionId}`);
    this.name = 'UnknownSession';
  }
}

export class SplitRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SplitRefused';
  }
}

export class AdmissionRefused extends Error {
  constructor(readonly failures: ReadonlyArray<{ code: string; detail: string }>) {
    super(`agent refused: ${failures.map((f) => f.detail).join('; ')}`);
    this.name = 'AdmissionRefused';
  }
}

/**
 * A session already has its agent (§4.2).
 *
 * Its own class rather than a bare `Error` for the reason `AdmissionRefused` is
 * one: a caller — the renderer, a CLI, the host protocol — should be able to
 * tell "this is a rule, here is what to do instead" from "something broke". The
 * message names the seat that is already there, because "refused" without the
 * incumbent's name is a dead end for the person reading it.
 */
export class SecondAgentRefused extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly incumbent: AgentId,
    reason: string,
  ) {
    super(reason);
    this.name = 'SecondAgentRefused';
  }
}

/** How a seat reads in a sentence: `lead · qwen2.5:7b` or `lead · echo`. */
function describeSeat(record: AgentRecord): string {
  return `${record.role} · ${record.spec.model?.modelId ?? record.spec.runtimeId}`;
}

/** Seats that still count: everything but the ones a replacement retired. */
export function activeAgents(session: Session): AgentRecord[] {
  return session.agents.filter((a) => a.status !== 'retired');
}

interface QueuedTurn {
  turn: UserTurn;
  resolve: () => void;
  reject: (err: Error) => void;
  /**
   * Captured when the turn is queued, not when it runs.
   *
   * A queued turn can start long after the client that sent it disconnected, so
   * asking "who is attached now" at execution time would attribute it to
   * whoever happens to be watching — or to nobody. The sender is a property of
   * the turn.
   */
  actor?: Actor;
}

export interface PendingPermission extends PermissionRequest {
  resolve: (d: PermissionDecision) => void;
  askedAt: string;
}

/** States that mean nothing more will happen without someone acting. */
function isSettled(state: SessionState): boolean {
  return state === 'done' || state === 'failed' || state === 'awaiting_input';
}

/** What a session has cost so far, summed across its agents. */
function totalCost(session: Session): number | 'unknown' {
  let total = 0;
  for (const agent of session.agents) {
    if (agent.usage.cost === 'unknown') return 'unknown';
    total += agent.usage.cost;
  }
  return total;
}

/** Grants apply to the asking agent, so its siblings are never widened. */
function clonePolicy(policy: ToolPolicy): ToolPolicy {
  return { defaultAction: policy.defaultAction, rules: policy.rules.map((r) => ({ ...r })) };
}

/**
 * How long a seat's raw output may sit unmirrored (§3.12).
 *
 * A quarter-second, which is a beat rather than a policy: long enough that a
 * chatty CLI rewrites the snapshot a few times a second instead of a few
 * hundred, short enough that "the pane survives a restart" is true of a restart
 * that happens while something is printing.
 */
const RAW_MIRROR_MS = 250;

interface LiveSession {
  session: Session;
  store: SessionStore;
  policy: ToolPolicy;
  handles: Map<AgentId, AgentHandle>;
  specs: Map<AgentId, AgentSpec>;
  /** Real controllers, so `ctx.abortSignal` can actually fire. */
  aborts: Map<AgentId, AbortController>;
  /**
   * What each seat's process printed, unparsed (§3.12, §7).
   *
   * Held **here** rather than on the handle beside it, which is the difference
   * between a terminal pane that works and one that is always empty. A handle
   * is a turn — `runTurn` deletes it the moment the turn ends — so a tail owned
   * by the handle was destroyed at exactly the moment a person went to read
   * what had just been printed. The session outlives every handle it opens, so
   * the tail does too, and `rawLog` can be answered between turns.
   *
   * Created lazily on the first reported line, which is also the availability
   * signal: a seat with an entry has a raw side, one without has never shown
   * that it has. Bounded three ways by `RawTailBuffer`, because unlike a
   * handle's this one lives as long as the session does.
   */
  rawTails: Map<AgentId, RawTailBuffer>;
  /** Whether this session has already recorded the move. */
  notedRelocation?: boolean;
  /**
   * When this session last appended anything.
   *
   * Not `updatedAt`, which moves only when an agent is added or the state
   * changes — a session mid-turn can go quiet for an hour without either. Every
   * append is the honest signal that something is still happening.
   */
  lastEventAt: number;
  /**
   * The turn to run again once the quota window resets.
   *
   * Held rather than reconstructed from the log: the turn is what the person
   * asked for and it did not complete, so resuming means running *that*, not
   * something inferred later from a transcript.
   */
  parked?: { resetsAt: number; agentId: AgentId; turn: UserTurn; actor?: Actor };
  /**
   * Agents queued behind a shared credential rather than doing anything (§8).
   *
   * Held because a session waiting for a quota slot is indistinguishable from a
   * hung one — both sit in `working` emitting nothing — and the stall detector
   * would flag it. A warning that fires on something working exactly as designed
   * is how a warning stops being read (§10).
   */
  waitingOnQuota: Set<AgentId>;
  /**
   * How deep the current exchange is, per agent (§4.2).
   *
   * A lead asks a worker, the worker asks back, and without a ceiling that is a
   * conversation with a bill attached and nobody watching. Held per agent
   * because the depth belongs to the turn being run, and cleared whenever a
   * *person* sends a turn — a human in the loop is exactly the thing the ceiling
   * exists to wait for.
   */
  hops: Map<AgentId, number>;
  /** Per-agent checkouts under `worktree` isolation (§9). */
  worktrees: Map<AgentId, Worktree>;
  /**
   * Splits an agent has asked for and nobody has answered (§4.3).
   *
   * Held rather than derived from state, because a pending proposal outlives
   * every state transition underneath it: the session goes on being
   * `awaiting_input` between turns, and an attention computed from state alone
   * would drop the question the moment anything else happened.
   */
  pendingSplits: Map<string, SplitProposal>;
  /** What this session owes its parent, from the brief it was spawned with. */
  contract?: ResultContract;
  /**
   * Live MCP connections, keyed by server id (§17 Q20).
   *
   * Owned here — beside the log and the gate — never by a runtime: §17.1's
   * rule, and also the practical one, since the process dies with this manager
   * and a runtime holding it would hold a corpse after every restart.
   */
  mcp: Map<string, McpConnection>;
  /** Skills injected into this session (§17 Q21). Pure data; rebuilt on resume. */
  skills: SkillConfig[];
}

/**
 * One workspace this manager has sessions in (DESIGN.md §5.1, §8).
 *
 * **Keyed by `instanceId`, never by path.** §5.2 makes `instanceId` the identity
 * of one checkout on one machine, and §5.3 makes a path the one thing about a
 * workspace that changes underneath you — so a map from path to workspace would
 * be a map that a `mv` invalidates, which is the failure relocation handling
 * exists to prevent. A session already carries its `instanceId`; that is the
 * whole lookup.
 */
export interface ManagedWorkspace {
  root: string;
  instanceId: InstanceId;
  /**
   * Where this checkout was before it moved (§5.3).
   *
   * Per workspace and not per manager, which is the point of the change: with
   * one manager holding several checkouts, "the workspace moved" is a fact about
   * one of them, and a manager-wide flag would discard every native resume token
   * in every other workspace because one folder was dragged.
   */
  relocatedFrom?: string;
}

export interface SessionManagerDeps {
  registry: RuntimeRegistry;
  /**
   * The workspace this manager starts with.
   *
   * Not "the workspace this manager is". A manager holds a *table* of open
   * workspaces (`ManagedWorkspace`) and a session names its own through
   * `instanceId`; this is simply the first entry, and the one a `createSession`
   * that names no folder lands in. Kept because every caller has exactly one
   * workspace to give at construction, and because a host that serves several
   * still has to have started somewhere.
   */
  workspaceRoot: string;
  instanceId: InstanceId;
  /**
   * How long a working session may go silent before it is called stalled.
   *
   * A judgement call, and deliberately generous. A model can legitimately take
   * minutes on a long generation and a tool can be slow; calling those stuck
   * would train the user to ignore the signal, which is the only failure mode
   * that matters for a warning. Five minutes of complete silence from something
   * that normally emits text as it goes is genuinely unusual.
   */
  stallAfterMs?: number;
  /**
   * Shared-credential scheduling (§8).
   *
   * Here rather than in main because this is where turns start: a scheduler
   * above the host could not gate a turn sent by the CLI, by a second client, or
   * by this manager's own parked-session sweeper waking at reset. §13's rule
   * that a bypassable gate is not a gate applies to this one too.
   */
  quota?: QuotaScheduler;
  /** Turns run at once on this host. Defaults to §8's `min(8, cores − 2)`. */
  maxConcurrentTurns?: number;
  /**
   * Set when this workspace was opened somewhere other than where it last was.
   *
   * A native resume token was minted by a vendor against the *old* location, so
   * the honest assumption is that it no longer describes anything — see
   * `openHandle`. Absent means "not known to have moved", which is also what an
   * `instance.json` written before relocation was tracked reports.
   */
  relocatedFrom?: string;
  /**
   * What this machine is called, for instructions a person has to carry out here.
   *
   * A manager runs *where the loop runs* (§6.3), so for a remote session this
   * object is inside the agent host on the other box — and a
   * `vendor-cli-session` credential lives on whichever machine runs the CLI
   * (§3.11), which is this one. "Run `claude auth login`" is therefore useless
   * without saying where, and worse than useless if the reader assumes their
   * own laptop. The host is the only party that can answer, so it answers with
   * its own hostname.
   *
   * Injectable only so tests do not assert against whatever the runner is
   * called; nothing in the app sets it.
   */
  machineName?: string;
  now?: () => Date;
}

/** Five minutes of complete silence from something that streams as it goes. */
const DEFAULT_STALL_AFTER_MS = 5 * 60 * 1_000;

/**
 * How much of each log the inbox folds.
 *
 * Bounded so opening it costs the same on a workspace used for a month as on one
 * opened yesterday, and generous enough that a session which finished overnight
 * is still in range — that being the case the inbox exists for.
 */
const INBOX_EVENT_WINDOW = 500;

/**
 * How many agent-to-agent hops may pass without a person.
 *
 * Generous enough for a real exchange — a lead briefing two workers, each
 * reporting back, a reviewer commenting — and small enough that a pair talking
 * in circles stops before it becomes expensive. The refusal is recorded, so a
 * roster that keeps hitting it is visible rather than merely slow.
 */
/**
 * What a seat thinks at when it says nothing and the model takes an effort.
 *
 * `max` because the targets this is aimed at are local: the cost of thinking
 * longer is electricity and latency rather than a bill, and a workbench for
 * unattended runs would rather wait than be asked twice.
 */
const DEFAULT_REASONING = 'max' as const;

/** A proposal, as the spawn that answers it. One reading, used by both paths. */
function spawnInputFor(proposal: SplitProposal): SpawnChildInput {
  return {
    title: proposal.title,
    scope: proposal.scope,
    outOfScope: proposal.outOfScope,
    contract: proposal.contract,
    tokenCeiling: proposal.tokenCeiling,
  };
}

const MAX_MESSAGE_HOPS = 8;

/**
 * Who the log says approved an automatic split.
 *
 * `via: 'asserted'` and an id that is plainly not a person: §5.1's rule is that
 * an actor says what established it and therefore what it is worth, and "the
 * grant you set earlier" is worth exactly as much as the grant. Attributing it
 * to the user who created the session would be true in spirit and would make
 * the transcript unable to answer "did I approve this one".
 */
const AUTO_ACTOR: Actor = { id: 'agbrte:split-grant', via: 'asserted', label: 'split grant' };

/**
 * One turn's concurrency slot, mutable so it can be given back and retaken.
 *
 * A plain `() => void` would be enough if a slot were held for the whole turn.
 * It is not: a turn parked on a permission prompt returns its slot and takes a
 * fresh one when answered, so what `send`'s `finally` must release is whichever
 * one is current rather than the one it started with.
 */
interface SlotHolder {
  release: () => void;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<SessionId, LiveSession>();
  /** The slot each running turn currently holds, so a prompt can hand it back. */
  private readonly turnSlots = new Map<AgentId, SlotHolder>();
  private readonly pending = new Map<string, PendingPermission>();
  /**
   * Request ids already answered in this process.
   *
   * Kept so a second client answering the same prompt gets `already-answered`
   * rather than `unknown` — the difference between "someone else got there
   * first" and "that prompt was never real", which the UI should not conflate.
   */
  private readonly answered = new Set<string>();
  /** Turns waiting to run, per agent. See `send`. */
  private readonly queues = new Map<AgentId, QueuedTurn[]>();
  /** Agents with a runner already draining, so a turn is never started twice. */
  private readonly draining = new Set<AgentId>();
  /** Seats with a raw-tail mirror already scheduled. See `mirrorRaw`. */
  private readonly rawFlushes = new Map<AgentId, NodeJS.Timeout>();
  private readonly now: () => Date;

  private readonly sweeper: NodeJS.Timeout;

  /**
   * The runtimes this manager can admit.
   *
   * Exposed because the host answers "what can this adapter do here" without a
   * session existing to ask it through, and reaching into `deps` from the server
   * would make the registry a shared mutable it does not own.
   */
  get registry(): RuntimeRegistry {
    return this.deps.registry;
  }

  /** Shared with nothing by default: one host, its own view of each credential. */
  private readonly quota: QuotaScheduler;
  /** How many turns this host runs at once (§8). */
  private readonly slots: TurnSlots;

  /**
   * The workspaces this manager has sessions in, by `instanceId` (§5.1, §8).
   *
   * A manager used to be one workspace, one log, one host. The middle of those
   * is the invariant and it is unchanged: **one log has one writer**, and each
   * session still owns exactly one log which only this process appends to. What
   * moved is the outer scope — a host is now one per *machine* (§8), so the
   * manager that host owns holds a table rather than a field. N logs under one
   * manager preserves single-writer exactly as N managers over N logs did; what
   * it additionally buys is that two sessions in different folders are in one
   * `sessions` map, which is what lets them be grouped and message each other
   * without the delivery crossing a process (§17 Q22).
   */
  private readonly workspaces = new Map<InstanceId, ManagedWorkspace>();

  constructor(private readonly deps: SessionManagerDeps) {
    super();
    this.now = deps.now ?? (() => new Date());

    this.workspaces.set(deps.instanceId, {
      root: deps.workspaceRoot,
      instanceId: deps.instanceId,
      ...(deps.relocatedFrom !== undefined ? { relocatedFrom: deps.relocatedFrom } : {}),
    });

    // One timer for every session and both jobs, rather than one each: each
    // check is a comparison against a number, and N timers would be N wakeups
    // to do what a single pass does. Swept at a fraction of the stall threshold
    // so a reported `since` is not off by a whole interval.
    //
    // Started regardless of `stallAfterMs`. Gating it on that was a bug: waking
    // a parked session and noticing silence are unrelated jobs that happened to
    // share a timer, so turning stall detection off also stopped every quota
    // window from ever resuming. `sweepStalled` disables itself instead.
    this.quota = deps.quota ?? new QuotaScheduler();
    // Injectable so a test is not at the mercy of the core count of whatever
    // machine it runs on — the cap is a property of the host, and a test about
    // queueing needs to be able to make one.
    this.slots = new TurnSlots(deps.maxConcurrentTurns);
    const after = deps.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.sweeper = setInterval(
      () => {
        this.sweepStalled();
        this.sweepParked();
      },
      Math.max(1_000, (after > 0 ? after : DEFAULT_STALL_AFTER_MS) / 5),
    );
    // Never hold the process open just to notice silence.
    this.sweeper.unref?.();
  }

  // --------------------------------------------------------------- workspaces

  /** Every workspace this manager holds sessions in (§5.1). */
  listWorkspaces(): ManagedWorkspace[] {
    return [...this.workspaces.values()];
  }

  /**
   * Open another workspace and hold its sessions alongside the rest (§8).
   *
   * Idempotent by `instanceId`, and **refused rather than aliased when the same
   * checkout turns up at a second path**: that is §5.3's fork — a folder copied
   * including `instance.json` — and resolving it is a decision with a UI, not
   * something a lookup may make on the way past. Refused *by name*, both paths
   * in the sentence, because a person can only act on it if they can see which
   * two folders are involved.
   *
   * `record` is off by default for the same reason `openWorkspace` defaults it
   * off (§5.3): recording consumes the relocation signal, and only the owner of
   * the workspace may spend it. The host passes `true`; nothing else should.
   */
  async addWorkspace(root: string, opts: { record?: boolean } = {}): Promise<ManagedWorkspace> {
    const identity = await openWorkspace(root, { ...(opts.record === true ? { record: true } : {}) });
    const held = this.workspaces.get(identity.instanceId);
    if (held !== undefined) {
      const here = resolvePath(identity.layout.root);
      if (resolvePath(held.root) === here) return held;

      /*
       * One checkout, two paths — which is two different things, and the
       * identity alone cannot tell them apart (§5.3).
       *
       * A folder that was **renamed** and a folder that was **copied including
       * `instance.json`** produce byte-identical evidence at the new path: same
       * `instanceId`, same `lastKnownPath` pointing somewhere else. The one
       * question that separates them is the one §5.3's flowchart asks — *is this
       * instance still at the old path?* If it is, both exist and this is the
       * fork, refused by name because resolving it is a decision with a UI. If
       * it is not, the folder moved, and refusing would mean a rename made a
       * workspace unopenable by the host that had it a moment ago.
       */
      const before = await peekIdentity(held.root).catch(() => null);
      if (before?.instanceId === identity.instanceId) {
        throw new Error(
          `the checkout at ${identity.layout.root} is the same one already open at ${held.root} ` +
            `— a copied \`instance.json\`, which is a fork to resolve rather than two workspaces to hold`,
        );
      }

      const moved: ManagedWorkspace = {
        root: here,
        instanceId: held.instanceId,
        relocatedFrom: held.root,
      };
      this.workspaces.set(moved.instanceId, moved);
      return moved;
    }
    const workspace: ManagedWorkspace = {
      root: identity.layout.root,
      instanceId: identity.instanceId,
      ...(identity.origin === 'relocated' && identity.movedFrom !== undefined
        ? { relocatedFrom: identity.movedFrom }
        : {}),
    };
    this.workspaces.set(workspace.instanceId, workspace);
    return workspace;
  }

  /**
   * The workspace a session belongs to.
   *
   * Resolved through `instanceId` and never through a stored path, so a session
   * whose folder moved between one open and the next resolves to wherever the
   * host found it (§5.3). A session naming an `instanceId` this manager does not
   * hold is a bug in whoever loaded it, and it is refused by name rather than
   * silently answered with the first workspace — which would write one
   * workspace's session into another one's directory.
   */
  workspaceOf(session: { instanceId: InstanceId; sessionId?: SessionId }): ManagedWorkspace {
    const held = this.workspaces.get(session.instanceId);
    if (held === undefined) {
      throw new Error(
        `no workspace ${session.instanceId} is open on this host${
          session.sessionId === undefined ? '' : `, so session ${session.sessionId} has nowhere to write`
        }`,
      );
    }
    return held;
  }

  /**
   * Which checkout a loaded session belongs to, synchronously.
   *
   * Synchronous because its caller is a *push*: the host has to decide, at the
   * moment an event is emitted, which connections it belongs to — and a client
   * bound to one folder must not be handed another folder's transcript. An
   * `await` there would put a round trip inside an event handler that runs on
   * every token.
   *
   * `null` for a session this manager has not loaded, which a caller must read
   * as *cannot say* and never as "send it to everyone".
   */
  instanceOf(sessionId: SessionId): InstanceId | null {
    return this.sessions.get(sessionId)?.session.instanceId ?? null;
  }

  /** The path of the workspace a live session writes into. */
  private rootOf(live: LiveSession): string {
    return this.workspaceOf(live.session).root;
  }

  /** Stop the stall sweeper. Sessions are unaffected; they live in the log. */
  dispose(): void {
    clearInterval(this.sweeper);
    // Pending mirrors are dropped rather than flushed: `dispose` is synchronous
    // because a process is trying to exit, and the file is a snapshot that the
    // next line rewrites whole. What is lost is the last beat of output.
    for (const timer of this.rawFlushes.values()) clearTimeout(timer);
    this.rawFlushes.clear();
    // MCP servers are child processes of *this* process and die with the
    // manager either way; killing them here just makes it orderly. The
    // sessions themselves are untouched — they live in the log (§17 Q20).
    for (const live of this.sessions.values()) {
      for (const connection of live.mcp.values()) connection.dispose();
      live.mcp.clear();
    }
  }

  /**
   * Remove the checkouts this manager cut, keeping their branches (§9).
   *
   * Separate from `dispose` because it touches the filesystem and can fail,
   * and because the two answer different questions: `dispose` stops timers so a
   * process can exit, while this tidies up disk. A caller that wants a clean
   * shutdown asks for both; a test that only wants its timers back does not have
   * to wait on git.
   *
   * The **branches survive**. Removing a checkout is housekeeping; removing a
   * branch would delete work nobody accepted, and a session ending is not the
   * same as its output being merged.
   */
  async releaseWorktrees(): Promise<void> {
    for (const live of this.sessions.values()) {
      for (const [agentId, worktree] of live.worktrees) {
        await removeWorktree(this.rootOf(live), worktree);
        live.worktrees.delete(agentId);
      }
    }
  }

  async createSession(input: CreateSessionInput, actor?: Actor): Promise<Session> {
    /*
     * Refused before anything exists (§17 Q20). A server id is spliced into
     * tool names the policy engine matches on and into event fields, so it is
     * allow-listed like a template name rather than sanitized — and checked
     * before `SessionStore.create`, because a refusal that leaves a session
     * directory behind is a refusal that made something.
     */
    for (const server of input.mcpServers ?? []) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(server.id)) {
        throw new Error(
          `MCP server id "${server.id}" — lowercase letters, digits, - and _ only, ` +
            `because the id becomes part of tool names policy rules match on`,
        );
      }
      if ((input.mcpServers ?? []).filter((s) => s.id === server.id).length > 1) {
        throw new Error(`two MCP servers named "${server.id}" — ids must be unique in a session`);
      }
    }
    for (const skill of input.skills ?? []) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(skill.id)) {
        throw new Error(
          `skill id "${skill.id}" — lowercase letters, digits, - and _ only, ` +
            `because the id becomes the tool name policy rules match on`,
        );
      }
      if ((input.skills ?? []).filter((s) => s.id === skill.id).length > 1) {
        throw new Error(`two skills named "${skill.id}" — ids must be unique in a session`);
      }
      // Refused rather than truncated: §17 Q7's cap applies to every tool
      // output, and instructions that arrive cut off would be a skill that
      // silently teaches half of what its author wrote.
      if (truncateToolOutput(skill.instructions) !== skill.instructions) {
        throw new Error(
          `skill "${skill.id}" is ${skill.instructions.length} characters; ` +
            `tool output is capped at 8,000, so it would reach the model truncated — split it`,
        );
      }
    }

    const sessionId = newSessionId();
    const createdAt = this.now().toISOString();

    /*
     * Which folder this session works in, chosen at creation (§5.1, §8).
     *
     * Opened here rather than assumed, because "the folder already has an
     * `.agbrte` with sessions in it" is the ordinary case and not an error: the
     * sessions that are there are the sessions you get, and `addWorkspace` is
     * idempotent by `instanceId` so naming the same folder twice costs one
     * `stat`. Absent means the workspace this manager was constructed with,
     * which is what every caller that has only ever had one folder still sends.
     */
    const workspace =
      input.workspaceRoot === undefined
        ? this.workspaceOf({ instanceId: this.deps.instanceId })
        : await this.addWorkspace(input.workspaceRoot);

    const store = await SessionStore.create(workspace.root, {
      sessionId,
      instanceId: workspace.instanceId,
      title: input.title,
      goal: input.goal,
      createdAt,
    }, { ...(actor !== undefined ? { actor } : {}) });

    const session: Session = {
      sessionId,
      instanceId: workspace.instanceId,
      target: input.target ?? { kind: 'local' },
      title: input.title,
      goal: input.goal,
      state: 'planning',
      agents: [],
      createdAt,
      updatedAt: createdAt,
      checklist: [],
      artifacts: [],
      needsAttention: null,
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
      ...(input.splitGrant !== undefined && input.splitGrant.count > 0
        ? {
            splitGrant: {
              remaining: input.splitGrant.count,
              granted: input.splitGrant.count,
              maxDepth: input.splitGrant.maxDepth,
            },
          }
        : {}),
      // A session created directly is a root of its own tree (§4.3); one
      // created *as* a child is given its position, because the manager that
      // owns the parent may not be this one.
      tree: input.child?.tree ?? { rootSessionId: sessionId, depth: 0, ancestry: [] },
      children: [],
      /*
       * No group, and a child does not inherit its parent's (§17 Q22).
       *
       * The same rule as the standing grant and as skills: a child session is
       * its own session and its *brief* is how a parent passes context down, so
       * anything ambient it received instead would be context the person who
       * approved the split never saw. A group is additionally an address other
       * sessions can reach, and inheriting one would hand a fresh child a set
       * of correspondents nobody chose for it.
       */
      pendingSplits: [],
    };

    // The §13 defaults are selected from the target, not left to the caller.
    // Computed here — once — because the standing grant event below carries it
    // and the live entry holds it, and two computations would be two chances
    // for the grant to be recorded against rules the session does not run.
    // Cloned so pushing the skill rules below never mutates a caller's object.
    const policy = clonePolicy(input.policy ?? defaultPolicyForTarget(session.target.kind));

    /*
     * Loading a skill is allowed by an explicit rule, not by a widened default
     * (§17 Q21). The body is text the person supplied at creation; gating them
     * from reading their own instructions back would be a prompt per paragraph.
     * A rule rather than a bypass, so it is inspectable, a user `deny` still
     * outranks it, and every load writes `permission.decided` via 'policy'
     * naming the rule that settled it.
     */
    for (const skill of input.skills ?? []) {
      policy.rules.push({ tool: `skill__${skill.id}`, action: 'allow' });
    }

    /*
     * The grant is an event, not only a field (§17 Q19): a transcript has to
     * say when the gate was relaxed and by whom, and the envelope's `at` and
     * `actor` are that answer. Every call it later settles still writes its
     * own `permission.decided`, so this line marks where the questions
     * stopped — never where the record did.
     *
     * `false` is stored as no grant at all, like a splitGrant of zero: a
     * field nobody can act on only exists to be misread. The live field is
     * built *from the appended envelope*, so "when was the gate relaxed" has
     * one answer whether it is read live or refolded after a restart. And the
     * event carries `policy` — the rules the person relaxed the gate beside —
     * because the effective policy is not otherwise durable, and a restart
     * that restored the grant onto rebuilt defaults would restore only the
     * permissive half of what was decided.
     */
    if (input.standingGrant === true) {
      const granted = await store.append(
        { type: 'permission.standing_grant', policy },
        { ...(actor !== undefined ? { actor } : {}) },
      );
      session.standingGrant = {
        grantedAt: granted.at,
        ...(actor !== undefined ? { grantedBy: actor } : {}),
      };
    }

    /*
     * Attach the session's MCP servers, each outcome recorded (§17 Q20).
     *
     * A failure attaches nothing and refuses nothing: the session still runs
     * with what did connect, and the `mcp.failed` line sits in the transcript
     * where the missing tools would have been (§3.5). The attach event records
     * env *names* only — the values are credentials, and a credential never
     * reaches a file that travels (§13). That asymmetry is also why a resumed
     * session does not silently reconnect: the log deliberately cannot.
     */
    // Durable whole (§17 Q21): a skill is pure data, so the log carries what
    // the model may later read and a resume rebuilds it from there — the
    // asymmetry with MCP above is the credential, not the mechanism.
    for (const skill of input.skills ?? []) {
      await store.append(
        {
          type: 'skill.attached',
          skillId: skill.id,
          description: skill.description,
          instructions: skill.instructions,
        },
        { ...(actor !== undefined ? { actor } : {}) },
      );
      session.skills ??= [];
      session.skills.push({ id: skill.id, description: skill.description });
    }

    const mcpConnections = new Map<string, McpConnection>();
    for (const server of input.mcpServers ?? []) {
      session.mcp ??= [];
      try {
        const connection = await McpConnection.connect(server);
        mcpConnections.set(server.id, connection);
        const toolNames = connection.tools.map((t) => `mcp__${server.id}__${t.name}`);
        await store.append(
          {
            type: 'mcp.attached',
            serverId: server.id,
            command: server.command,
            ...(server.args !== undefined ? { args: server.args } : {}),
            ...(server.env !== undefined ? { envKeys: Object.keys(server.env) } : {}),
            toolNames,
          },
          { ...(actor !== undefined ? { actor } : {}) },
        );
        session.mcp.push({ id: server.id, tools: toolNames });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await store.append(
          { type: 'mcp.failed', serverId: server.id, reason },
          { ...(actor !== undefined ? { actor } : {}) },
        );
        session.mcp.push({ id: server.id, tools: [], error: reason });
      }
    }

    /*
     * The brief is written to the child's own log by whoever creates it.
     *
     * §4.3: "the brief is durable, not an opening prompt" — a session resumed in
     * three weeks still knows why it exists, and that has to hold whichever
     * machine it woke up on. `spawnChild` used to append this itself, reaching
     * into a live session it had just created; that reach is exactly what a
     * cross-host child does not have.
     */
    if (input.child !== undefined) {
      await store.append({
        type: 'session.brief_received',
        brief: input.child.brief,
        parentSessionId: input.child.tree.ancestry.at(-1)!,
      });
    }

    // Live forwarding for the UI (§7). Wired here rather than from the IPC
    // layer so exactly one place knows which session a store belongs to, and
    // the renderer never receives an event it cannot attribute.
    store.onAppend = (event) => {
      this.spoke(sessionId);
      this.emit('event', sessionId, event);
    };

    this.sessions.set(sessionId, {
      session,
      store,
      // An empty default policy meant every call fell through to `ask`, which is
      // safe but means the documented local/remote distinction never applied.
      policy,
      handles: new Map(),
      specs: new Map(),
      aborts: new Map(),
      rawTails: new Map(),
      lastEventAt: this.now().getTime(),
      waitingOnQuota: new Set<AgentId>(),
      hops: new Map<AgentId, number>(),
      worktrees: new Map<AgentId, Worktree>(),
      pendingSplits: new Map<string, SplitProposal>(),
      mcp: mcpConnections,
      skills: [...(input.skills ?? [])],
    });

    this.emit('session', session);
    return session;
  }

  get(sessionId: SessionId): Session {
    return this.live(sessionId).session;
  }

  list(): Session[] {
    return [...this.sessions.values()].map((l) => l.session).sort(byAttentionThenRecency);
  }

  /**
   * Admit this session's agent, refusing a second one and configurations that
   * cannot run safely.
   *
   * Admission happens here rather than at the first tool call, so an
   * `all-or-nothing` runtime never reaches a shared workspace and a role's
   * capability floor is enforced before any work starts (§3.10, §4.2, §9).
   *
   * ## One session, one agent
   *
   * §4.2: a session is one model, and collaboration between models is the
   * *group* feature (§17 Q22) — separate sessions, separate logs, separate
   * bills, a bounded channel between them. The cap is enforced here, in the
   * owner of the log, rather than by hiding a button: three clients reach this
   * (the app, the CLI, an attached browser), plus template application, and a
   * rule that lives in one renderer is a rule the other two do not have.
   *
   * Changing the model is therefore a *replacement*, not an addition:
   * `input.replacing` names the seat being taken over, the incumbent is retired
   * in the log, and the new seat is admitted. The order matters and is the
   * reason the retirement is not done first: admission can refuse — an
   * uninstalled CLI, a model below the role's floor — and a session left with
   * no agent because the replacement was refused would be a working session
   * destroyed by a rejected form.
   *
   * Sessions created before this rule may hold two seats. They keep working,
   * keep attributing their rows, and are readable and resumable; what they
   * cannot do is grow a third. That is the only asymmetry, and it is deliberate
   * — §5.1 makes the log permanent, so a rule about what may be *created* can
   * never be a rule about what already exists. Changing the model of one of
   * their seats is allowed and leaves the count where it was: the rule is that
   * a roster never *grows*, not that a session with two seats is frozen.
   */
  async addAgent(sessionId: SessionId, input: NewAgentInput, actor?: Actor): Promise<AgentRecord> {
    const live = this.live(sessionId);
    const seated = activeAgents(live.session);
    const replacing =
      input.replacing !== undefined
        ? live.session.agents.find((a) => a.agentId === input.replacing)
        : undefined;

    if (input.replacing !== undefined) {
      // Named a seat that is not here at all: usually a stale client holding a
      // session it has not re-read. Said by id, since that is what it sent.
      if (replacing === undefined) {
        throw new Error(
          `no agent ${input.replacing} in this session, so there is nothing to replace — ` +
            `reload the session and choose again`,
        );
      }
      if (replacing.status === 'retired') {
        throw new SecondAgentRefused(
          sessionId,
          seated[0]?.agentId ?? replacing.agentId,
          `${replacing.agentId} was already retired${
            seated[0] !== undefined ? ` and this session now runs ${describeSeat(seated[0])}` : ''
          } — somebody else changed the model first, so re-read the session before changing it again`,
        );
      }
      /*
       * A seat mid-turn is not replaced out from under itself.
       *
       * Retiring it would leave a running loop writing into a transcript that
       * says it is gone, and the turn's result would land on a seat nobody can
       * send to. Refused rather than interrupted, because interrupting is a
       * decision a person makes deliberately — there is a button for it — and
       * doing it silently as a side effect of a dropdown would throw away a
       * turn somebody is paying for.
       */
      if (replacing.status === 'running') {
        throw new Error(
          `${describeSeat(replacing)} is mid-turn; interrupt it first, then change the model — ` +
            `replacing a running seat would abandon the turn it is being paid for`,
        );
      }
    }

    /*
     * The refusal itself. Named seat, named alternative — a person reading this
     * has to be able to act on it without knowing the architecture.
     */
    if (replacing === undefined && seated.length > 0) {
      const incumbent = seated[0]!;
      throw new SecondAgentRefused(
        sessionId,
        incumbent.agentId,
        `this session already has an agent (${describeSeat(incumbent)}) and a session holds ` +
          `exactly one. Use "Agent…" to change the model — the seat is retired and the new one ` +
          `takes over, both recorded in the transcript — or start a second session and group ` +
          `the two so the models can message each other.`,
      );
    }

    return this.admitSeat(live, input, replacing ?? null, actor);
  }

  /**
   * Everything an admission does once the roster rule has been answered.
   *
   * Split from `addAgent` so the cap is one guard in one place with nothing
   * after it that could quietly grow a second entry point — and so the
   * replacement path is *the same* admission as a first seat, rather than a
   * near-copy that drifts.
   */
  private async admitSeat(
    live: LiveSession,
    input: NewAgentInput,
    replacing: AgentRecord | null,
    actor?: Actor,
  ): Promise<AgentRecord> {
    const requested = input.isolation ?? 'shared';

    const spec: AgentSpec = {
      agentId: newAgentId(),
      role: input.role,
      runtimeId: input.runtimeId,
      auth: input.auth ?? { kind: 'none' },
      // A *copy*, not the session's object. Sharing the reference meant a
      // pattern grant approved for a trusted agent silently widened every other
      // agent in the session — including one on a coarse-gated runtime (§13).
      toolPolicy: input.policy ?? clonePolicy(live.policy),
      limits: input.limits ?? {},
      workspacePath: this.rootOf(live),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    };

    /**
     * What isolation this agent will actually get (§9).
     *
     * > Non-git workspaces fall back to `shared` with leases (and therefore
     * > cannot host an `all-or-nothing` agent at all).
     *
     * Resolved *before* admission, and that ordering is the whole point. The
     * fallback is not a quiet downgrade: admission then runs against what the
     * agent really gets, so §3.10's rule refuses an `all-or-nothing` runtime
     * here — with the missing capability named — rather than admitting it as
     * "contained" and handing it the workspace root. Deciding after admission
     * would produce exactly that: a decision that said isolated and a filesystem
     * that was not.
     */
    let isolation = requested;
    let downgraded: string | null = null;
    if (requested === 'worktree') {
      const support = await worktreeSupport(this.rootOf(live));
      if (!support.ok) {
        isolation = 'shared';
        downgraded = support.reason;
      }
    }

    const admission = await this.deps.registry.admit(spec, isolation, input.requirements ?? {});
    if (!admission.ok) throw new AdmissionRefused(admission.failures);

    // Cut after admission, so a configuration that was going to be refused
    // anyway does not leave a branch behind.
    if (isolation === 'worktree') {
      const worktree = await createWorktree(this.rootOf(live), spec.agentId);
      live.worktrees.set(spec.agentId, worktree);
      spec.workspacePath = worktree.path;
    }

    /*
     * The default effort is chosen here and nowhere earlier, because here is the
     * first point anything knows whether the model takes one (§3.3).
     *
     * A seat that asked for nothing gets `max` on a target that can think, and
     * nothing at all on one that cannot — the adapter rejects an effort a model
     * does not support outright, so a blanket default would break every plain
     * model rather than degrade on it.
     */
    if (spec.reasoning === undefined && admission.capabilities.reasoningControl === 'effort') {
      spec.reasoning = { mode: DEFAULT_REASONING };
    }

    const record: AgentRecord = {
      agentId: spec.agentId,
      role: spec.role,
      spec: stripWorkspacePath(spec),
      resolvedCapabilities: admission.capabilities,
      status: 'idle',
      isolation,
      resumeToken: null,
      lastEventSeq: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    };

    /*
     * The incumbent goes out here — after admission, before the newcomer is
     * pushed (§4.2).
     *
     * After, so a refused replacement leaves the session exactly as it was:
     * every throw above this line happens with the old seat still seated and
     * still sendable. Before the push, so there is no instant at which
     * `activeAgents` returns two — the window in which a second client could
     * read a two-seat roster and act on it.
     *
     * Its worktree, if it had one, is deliberately left alone: a checkout can
     * hold uncommitted work, and quietly deleting a branch because somebody
     * changed model is not a decision this method gets to make.
     */
    if (replacing !== null) await this.retireSeat(live, replacing, spec.agentId, actor);

    live.session.agents.push(record);
    live.specs.set(spec.agentId, spec);

    // Said out loud. An agent that asked for its own checkout and did not get
    // one is working under different rules than its configuration reads, and a
    // downgrade nobody was told about is how that becomes a surprise later.
    if (downgraded !== null) {
      this.emit('progress', live.session.sessionId, {
        kind: 'phase',
        detail: `${spec.agentId} asked for worktree isolation and is running shared: ${downgraded}`,
        at: this.now().toISOString(),
      });
    }

    /*
     * Same rule, for the standing grant (§17 Q19, §3.10). The grant settles
     * asks per call, which needs a gate we can answer per call. On a
     * `precomputed-allowlist` runtime an `ask` compiles to deny before the
     * process starts, so the grant is reached only through deny-and-resume
     * rounds — bounded, a restart each, and unavailable where the CLI cannot
     * resume at all. Said now, while the person who granted is still here,
     * rather than discovered as a stalled run the next morning — the exact
     * moment §3.5 says a degradation must be named. The adapter is not told
     * about the grant; this is the orchestrator describing the seam, not the
     * seam being moved.
     */
    if (
      live.session.standingGrant !== undefined &&
      admission.capabilities.permissionFidelity !== 'callback'
    ) {
      this.emit('progress', live.session.sessionId, {
        kind: 'phase',
        detail:
          `${spec.agentId} runs a ${admission.capabilities.permissionFidelity} gate, so this ` +
          `session's standing grant cannot answer its asks per call: each new ask costs a ` +
          `deny-and-resume round, and calls settled by a widened allowlist term are accounted ` +
          `by the CLI rather than the log`,
        at: this.now().toISOString(),
      });
    }

    // Durable, so a reloaded log can resolve this agentId to its runtime, model,
    // isolation, and gate strength — which every logged decision references.
    await live.store.append(
      {
        type: 'agent.created',
        role: spec.role,
        runtimeId: spec.runtimeId,
        isolation,
        permissionFidelity: admission.capabilities.permissionFidelity,
        capabilities: admission.capabilities,
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        // Persisted so `resumeSession` rebuilds this exact spec rather than a
        // default-shaped lookalike.
        ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
        ...(Object.keys(spec.limits).length > 0 ? { limits: spec.limits } : {}),
        ...(spec.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
      },
      {
        agentId: spec.agentId,
        origin: this.originFor(spec),
        ...(actor !== undefined ? { actor } : {}),
      },
    );

    this.touch(live);
    return record;
  }

  /**
   * Take a seat out of service, permanently and in the log (§4.2, §5.1).
   *
   * The transcript is the point. A session whose answers change character
   * halfway down because somebody swapped a 7B local model for a frontier one
   * has to *say so*, at the position where it happened and with the person who
   * did it attached — otherwise the record reads as one model behaving
   * inexplicably. `agent.created` for the newcomer alone would not do it: two
   * creations with no retirement between them is what a legacy two-seat roster
   * looks like, and the two shapes have to stay distinguishable forever.
   *
   * The spec is dropped so nothing can send to the seat again; the record stays
   * in `session.agents` so every row it wrote keeps its name.
   */
  private async retireSeat(
    live: LiveSession,
    seat: AgentRecord,
    replacedBy: AgentId | undefined,
    actor?: Actor,
  ): Promise<void> {
    seat.status = 'retired';
    live.specs.delete(seat.agentId);
    // Any turn still queued for it would never drain — nothing will run them —
    // so they are rejected here rather than left as promises nobody settles.
    const queued = this.queues.get(seat.agentId) ?? [];
    this.queues.delete(seat.agentId);
    for (const q of queued) {
      q.reject(new Error(`${describeSeat(seat)} was retired before this turn ran`));
    }

    /*
     * Belt and braces on the process behind it.
     *
     * A seat mid-turn is refused a replacement, and a finished turn releases its
     * handle, so ordinarily there is nothing here. A turn that threw on its way
     * out is the case that leaves one — and a wrapped CLI's subprocess with
     * nothing left that could ever send to it is a process kept alive for the
     * lifetime of the session. Failures are swallowed because this is cleanup
     * after a decision that has already been made: a stubborn subprocess must
     * not turn a model change into an error.
     */
    const handle = live.handles.get(seat.agentId);
    if (handle !== undefined) {
      live.handles.delete(seat.agentId);
      live.aborts.delete(seat.agentId);
      await handle.stop('the seat was retired when this session’s model changed').catch(
        () => undefined,
      );
    }

    await live.store.append(
      {
        type: 'agent.retired',
        reason: replacedBy !== undefined ? 'replaced' : 'removed',
        ...(replacedBy !== undefined ? { replacedBy } : {}),
        was: describeSeat(seat),
      },
      {
        agentId: seat.agentId,
        ...(actor !== undefined ? { actor } : {}),
      },
    );
  }

  /** Send a turn and run it to completion, applying the resulting state. */
  /**
   * Queue a turn for an agent and resolve when *this* turn completes.
   *
   * Several clients may hold read-write access at once (§17 Q14), so two people
   * can send to the same agent. Turns are queued in arrival order at the owner
   * rather than raced: arrival here is the only ordering that exists, since
   * client clocks disagree and neither client can see the other's send.
   *
   * The queue is **per agent**, not per session. Agents in one session are meant
   * to run in parallel (§4.2), so a session-wide queue would serialize work that
   * is supposed to be concurrent. With one agent the two are identical, which is
   * why this costs nothing today and is correct later.
   *
   * A turn survives the client that sent it. Queued work belongs to the session
   * owner, so closing the app — or the phone going to sleep — does not cancel
   * what was already asked for.
   *
   * **Not durable across an owner crash.** A queued turn has not happened yet, so
   * writing it to the log would put something in the transcript that never ran.
   * The alternative, a separate durable queue, buys little: depth is normally
   * zero or one, and a crash already costs the running turn.
   */
  async send(sessionId: SessionId, agentId: AgentId, turn: UserTurn, actor?: Actor): Promise<void> {
    // A person in the loop is what the hop ceiling is waiting for, so their turn
    // clears it for the whole session rather than only for the agent they
    // addressed — the exchange they interrupted is over.
    if (actor !== undefined) this.live(sessionId).hops.clear();

    // Validate before queueing, so a bad target fails at the call rather than
    // silently much later when the queue drains to it.
    const live = this.live(sessionId);
    this.agent(live, agentId);

    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(agentId) ?? [];
      queue.push({ turn, resolve, reject, ...(actor !== undefined ? { actor } : {}) });
      this.queues.set(agentId, queue);
      this.emit('queue', sessionId, agentId, queue.length);
      void this.drain(sessionId, agentId);
    });
  }

  /** Turns waiting behind the one running, for a client to display. */
  queueDepth(agentId: AgentId): number {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /**
   * The raw stdout/stderr tail of the process behind one agent (§3.12, §7).
   *
   * `null` means exactly one thing now: **this seat has never printed a raw
   * line**, either because its runtime has no process to show — the harness,
   * `echo` — or because it has not run yet in this host. It no longer also
   * means "between turns", which is what made the terminal pane useless: the
   * tail is kept by the session rather than by the handle, so it survives a
   * finished turn, a crashed worker, and however many processes a
   * deny-ask-resume took.
   *
   * A window on what was printed, not a second transcript. It *is* restored when
   * a session is reopened, from the mirror written beside the log by the run
   * that filled it (`store/rawTailFile.ts`) — the same bytes, not the log
   * re-rendered to look like terminal output. The log remains the durable
   * record: resume, the gate and every projection read it and none of them read
   * this.
   */
  rawLog(sessionId: SessionId, agentId: AgentId): RawTail | null {
    const live = this.live(sessionId);
    // Validated so an unknown agent is an error rather than a quiet null —
    // "no raw side" and "you asked about nobody" are different answers and only
    // one of them should hide a control.
    this.agent(live, agentId);
    return live.rawTails.get(agentId)?.tail() ?? null;
  }

  /**
   * One line an adapter reported, kept for the terminal view.
   *
   * The ring is created on the first line rather than at admission, which makes
   * its existence the availability signal: only a seat that has actually
   * printed something claims a raw side, so no UI offers a pane that can only
   * ever be empty.
   */
  private keepRaw(live: LiveSession, agentId: AgentId, line: string): void {
    let tail = live.rawTails.get(agentId);
    if (tail === undefined) {
      tail = new RawTailBuffer();
      live.rawTails.set(agentId, tail);
    }
    tail.push(line);
    this.mirrorRaw(live, agentId);
  }

  /**
   * Mirror a seat's ring to disk, at most once a beat.
   *
   * Coalesced rather than written per line, because a CLI mid-tool-call prints
   * hundreds a second and the file is a *snapshot* — writing each one would
   * rewrite the whole quarter-megabyte tail to record one line of it. The
   * window is small enough that what a crash costs is the last blink of output,
   * against a pane that was empty on every restart before.
   *
   * Trailing, and never awaited by a turn: a slow disk must not become
   * backpressure on an agent, so a failed write is dropped. The next line
   * schedules another, and the file is a snapshot, so one lost write is
   * repaired by the next rather than leaving a gap.
   */
  private mirrorRaw(live: LiveSession, agentId: AgentId): void {
    if (this.rawFlushes.has(agentId)) return;
    const timer = setTimeout(() => {
      this.rawFlushes.delete(agentId);
      void this.flushRaw(live, agentId);
    }, RAW_MIRROR_MS);
    // So a pending mirror never holds a process open — the tail is a
    // convenience and nothing may wait on it.
    timer.unref?.();
    this.rawFlushes.set(agentId, timer);
  }

  /**
   * Bring back what this session's seats printed on an earlier run.
   *
   * Read once, at reopen, and never merged into a ring that has started
   * collecting — a restored tail is the *beginning* of this run's pane, with
   * the previous run's output above whatever the next turn prints. Failure is
   * silent for the same reason the mirror's is: a session must open whether or
   * not the pane beside it can be filled.
   */
  private async restoreRawTails(live: LiveSession): Promise<void> {
    let mirrored: Map<string, RawTail>;
    try {
      mirrored = await loadRawTails(this.rootOf(live), live.session.sessionId);
    } catch {
      return;
    }
    for (const [agentId, tail] of mirrored) {
      if (live.rawTails.has(agentId as AgentId)) continue;
      const buffer = new RawTailBuffer();
      buffer.restore(tail);
      live.rawTails.set(agentId as AgentId, buffer);
    }
  }

  /** Write one seat's ring now, if it has anything to say. */
  private async flushRaw(live: LiveSession, agentId: AgentId): Promise<void> {
    const tail = live.rawTails.get(agentId);
    if (tail === undefined || tail.isEmpty) return;
    try {
      await saveRawTail(this.rootOf(live), live.session.sessionId, agentId, tail.tail());
    } catch {
      // See `mirrorRaw`: the next line repairs it, and a turn must not fail
      // because a tail could not be mirrored.
    }
  }

  /**
   * Run queued turns for one agent, one at a time.
   *
   * Guarded by `draining` rather than by queue length: two concurrent sends would
   * otherwise each see a non-empty queue and start a runner, and the same turn
   * would be delivered twice.
   */
  private async drain(sessionId: SessionId, agentId: AgentId): Promise<void> {
    if (this.draining.has(agentId)) return;
    this.draining.add(agentId);
    try {
      for (;;) {
        const queue = this.queues.get(agentId);
        const next = queue?.shift();
        if (!next) return;
        this.emit('queue', sessionId, agentId, queue?.length ?? 0);
        try {
          await this.runTurn(sessionId, agentId, next.turn, next.actor);
          next.resolve();
        } catch (err) {
          // One failed turn must not strand the turns behind it.
          next.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this.draining.delete(agentId);
    }
  }

  private async runTurn(
    sessionId: SessionId,
    agentId: AgentId,
    turn: UserTurn,
    actor?: Actor,
  ): Promise<void> {
    const live = this.live(sessionId);
    const record = this.agent(live, agentId);
    const spec = live.specs.get(agentId);
    if (!spec) throw new Error(`agent ${agentId} has no spec`);

    const runtime = this.deps.registry.get(spec.runtimeId);

    // The handle is opened *before* this turn is logged. A rehydrated seed is
    // built from the log, so appending first would put the incoming turn into
    // the seed and then send it again — the agent would see it twice.
    let handle = live.handles.get(agentId);
    if (!handle) {
      handle = await this.openHandle(live, record, spec, runtime);
    }

    /**
     * Fitted to what this agent declared it can take (§12.2).
     *
     * Here rather than in the harness, and that placement is the point: this is
     * the only process holding both the blob store and the agent's capabilities.
     * A resizer inside the adapter could decide an image was too large and had
     * no way to reach the bytes to do anything about it.
     *
     * Per agent, not per session: one session can hold a frontier lead and a
     * local worker with different limits, and the answer belongs to whoever is
     * receiving this turn.
     */
    const fitted = await fitContent(
      turn.content,
      record.resolvedCapabilities,
      (image, max) => this.rescale(live, image, max),
      // §12.3's flattening, here for the same reason as the resizer: this is the
      // only process holding both the blob store and the agent's capabilities.
      (image, annotations) => this.burnAnnotations(live, image, annotations),
    );
    for (const note of fitted.downgrades) {
      // Reported, never silent. §3.5: "this model keeps ignoring my screenshots"
      // should have a visible cause rather than becoming folklore.
      this.emit('progress', live.session.sessionId, {
        kind: 'phase',
        detail: note.detail,
        at: this.now().toISOString(),
      });
    }

    await live.store.append(
      { type: 'user.turn', content: fitted.content },
      { agentId, ...(actor !== undefined ? { actor } : {}) },
    );
    await this.setState(live, 'working');

    record.status = 'running';

    /**
     * Queue behind whatever else shares this credential (§8).
     *
     * After the turn is logged and the session is `working`, so the transcript
     * shows what was asked and the UI shows something happening — a wait that
     * looked like nothing at all would be worse than the wait.
     *
     * Immediate for a local model, and for any credential nothing has complained
     * about yet, which is every credential until a provider says otherwise.
     */
    const group = groupFor(spec.auth);
    live.waitingOnQuota.add(agentId);
    try {
      await this.quota.acquire(group, (ms) =>
        this.contextFor(live, spec).reportProgress({
          kind: 'phase',
          detail: `waiting ${Math.round(ms / 1000)}s for the shared credential`,
          at: this.now().toISOString(),
        }),
      );
    } finally {
      live.waitingOnQuota.delete(agentId);
    }

    /**
     * A slot on this machine, taken **after** the credential wait (§8).
     *
     * The order is the decision. Waiting on a shared allowance costs this host
     * nothing, so holding one of its scarce slots through that wait would starve
     * agents on a *different* credential that could have run. §8 keeps these as
     * "three independent limits" and this is what that separation buys.
     *
     * Held for as long as the turn runs, **except while a human is being waited
     * for** — see `decide`. That exception was not here, and the reasoning
     * against it ("the worker is resident and costing memory whether or not
     * anyone has answered") is true and is outweighed: a permission prompt can
     * go unanswered for hours, which is the entire premise of §11's inbox, and a
     * quota wait is already outside this slot for exactly the same reason one
     * line up.
     *
     * A parent waiting on children holds nothing: `propose_split` returns inside
     * the turn, so the parent's turn ends and its slot goes back before any child
     * asks for one. Without that a tree deeper than the cap would deadlock.
     */
    const holder: SlotHolder = { release: await this.acquireSlot(live, spec) };
    // Mutable and keyed by agent, because `decide` has to be able to hand this
    // slot back mid-turn and take a fresh one afterwards.
    this.turnSlots.set(agentId, holder);

    let outcome;
    try {
      const pumped = pumpAgent(handle, live.store, { origin: this.originFor(spec), agentId });
      await handle.send({ content: fitted.content });
      outcome = await pumped;
    } finally {
      // Whatever happened, and whichever slot is current. A slot leaked by a
      // thrown turn is a host that runs one fewer agent for the rest of its
      // life, and nothing would report it. `release` is idempotent, so a turn
      // that threw while parked on a prompt gives back nothing twice.
      holder.release();
      this.turnSlots.delete(agentId);
    }

    // What one agent learned about the credential, before the others send. This
    // is the entire reason a group exists: eight agents on one allowance should
    // not each spend a request discovering the same spent window.
    this.quota.observe(group, outcome.stop);

    record.resumeToken = outcome.resumeToken;
    record.lastEventSeq = live.store.nextSeq - 1;
    record.usage = mergeUsage(record.usage, outcome.usage);
    record.status = outcome.disposition === 'fail' ? 'stopped' : 'idle';

    // A finished turn releases the handle so the next send resumes cleanly;
    // parked agents are what make many concurrent sessions affordable (§8).
    // `live.rawTails` is deliberately *not* cleared here: what the process
    // printed is the thing somebody opens the terminal pane to read after the
    // turn, and releasing it with the handle is what made that pane empty.
    live.handles.delete(agentId);
    live.aborts.delete(agentId);

    // Parked with everything needed to pick it up again. A window that reports
    // no `resetsAt` is not parked: waking at a time nobody named would be a
    // guess, and this waits for a person instead.
    if (outcome.stop.kind === 'quota_exhausted' && outcome.stop.resetsAt !== undefined) {
      const resetsAt = Date.parse(outcome.stop.resetsAt);
      if (Number.isFinite(resetsAt)) {
        live.parked = { resetsAt, agentId, turn, ...(actor !== undefined ? { actor } : {}) };
      }
    }

    await this.surfaceMerge(live, agentId);

    await this.setState(live, outcome.nextState, this.stopReason(outcome.stop, live));
    await live.store.maybeCheckpoint();
  }

  /**
   * Two-tier resume (§5.4). The native token is a cache; the log is truth.
   *
   * Gated on the *capability*, not on whether a token happens to exist. Gating
   * on token presence meant every `nativeResume: false` runtime silently started
   * fresh each turn while logging `resumeMode: 'fresh'` as though intentional —
   * so the session's memory reset and nothing said so.
   */
  private async openHandle(
    live: LiveSession,
    record: AgentRecord,
    spec: AgentSpec,
    runtime: AgentRuntime,
  ): Promise<AgentHandle> {
    const caps = record.resolvedCapabilities;
    const ctx = this.contextFor(live, spec);

    // Skipped outright after a move, rather than attempted and allowed to fail.
    // A vendor's resume token was minted against the old path, and the two ways
    // it can behave are both bad: reject — which costs a round trip to learn
    // what we already know — or *succeed* against state that describes a
    // directory the code is no longer in. §15's criterion for this phase is
    // explicitly "verified with the native resume token deliberately
    // invalidated", because the durable path is the one that has to carry it.
    // Per workspace, not per manager: one host now holds several checkouts
    // (§8), and one of them moving must not throw away the resume tokens of
    // sessions in the folders that did not.
    const workspace = this.workspaceOf(live.session);
    const trustToken = workspace.relocatedFrom === undefined;

    // Recorded whether or not there was a token to discard. The move is a fact
    // about the workspace, not about one runtime's resume support — putting it
    // inside the token branch meant a runtime that mints no token left no trace
    // of having moved at all. Once per session, not once per agent, or the log
    // fills with the same sentence.
    if (!trustToken && !live.notedRelocation) {
      live.notedRelocation = true;
      await live.store.append({
        type: 'workspace.relocated',
        from: workspace.relocatedFrom as string,
        to: workspace.root,
      });
    }

    if (!trustToken && record.resumeToken !== null) {
      this.emit(
        'resume-rejected',
        live.session.sessionId,
        spec.agentId,
        new Error(`workspace moved from ${workspace.relocatedFrom}; native resume token discarded`),
      );
    }

    if (trustToken && caps.nativeResume && record.resumeToken !== null) {
      try {
        const handle = await runtime.resume(spec, record.resumeToken, ctx);
        live.handles.set(spec.agentId, handle);
        await live.store.append(
          { type: 'agent.started', resumeMode: 'native' },
          { agentId: spec.agentId, origin: this.originFor(spec) },
        );
        return handle;
      } catch (err) {
        // Rejection is expected and ordinary — a moved workspace, an upgraded
        // runtime, an expired token. Fall through to the durable path.
        this.emit('resume-rejected', live.session.sessionId, spec.agentId, err);
      }
    }

    const seed = await rehydrate(live.store, {
      budgetTokens: Math.floor(caps.contextWindow * 0.5),
    });

    const handle = await runtime.start(spec, {
      ...ctx,
      ...(seed.isEmpty ? {} : { seedHistory: seed.seed }),
    });
    live.handles.set(spec.agentId, handle);

    await live.store.append(
      {
        type: 'agent.started',
        resumeMode: seed.isEmpty ? 'fresh' : 'rehydrated',
        ...(seed.isEmpty ? {} : { seededThroughSeq: seed.seededThroughSeq }),
      },
      { agentId: spec.agentId, origin: this.originFor(spec) },
    );

    return handle;
  }

  /**
   * Interrupt one agent or all of them.
   *
   * Capability-gated: a runtime that declares `interruptible: false` is not
   * asked, and the refusal is reported rather than silently doing nothing.
   * §3.3 says capabilities are enforced, not assumed — this was the call site
   * that assumed. The abort signal fires either way, so an adapter that honors
   * only `ctx.abortSignal` is still cancellable.
   */
  async interrupt(sessionId: SessionId, agentId?: AgentId, actor?: Actor): Promise<void> {
    const live = this.live(sessionId);
    const targets = agentId ? [agentId] : [...live.handles.keys()];

    for (const id of targets) {
      const record = live.session.agents.find((a) => a.agentId === id);
      live.aborts.get(id)?.abort(new Error('interrupted'));

      const interruptible = record?.resolvedCapabilities.interruptible !== false;
      if (!interruptible) {
        this.emit('degraded', live.session.sessionId, id, 'runtime is not interruptible');
      } else {
        await live.handles.get(id)?.interrupt();
      }

      // Logged either way, and *after* the attempt so `delivered` reports what
      // happened rather than what was intended. A stop that the runtime could
      // not honour is the case a transcript most needs to explain: without this
      // the turn simply carries on and the log offers no reason why.
      await live.store.append(
        {
          type: 'agent.interrupted',
          delivered: interruptible,
          ...(interruptible ? {} : { note: 'this runtime cannot be interrupted mid-turn' }),
        },
        { agentId: id, ...(actor !== undefined ? { actor } : {}) },
      );
    }

    /**
     * A session that is `working` with nothing running is stuck, and this is the
     * only thing that can say so.
     *
     * The manager owns the turn loop, so a handle is registered before the state
     * becomes `working` and removed when the turn ends. `working` with an empty
     * handle map therefore means the agent went away mid-turn — the host died,
     * the adapter crashed — and nothing else will ever move it: §10 will not let
     * stall detection change the state, because a stall is a suspicion and an
     * agent may simply be slow.
     *
     * Left alone, that session holds the host busy forever: `shutdown` refuses
     * while anything is `working`, so the host cannot be asked to exit and
     * upgrading it means killing the process. Found in the field, doing exactly
     * that.
     *
     * Only on an *explicit* interrupt. A person typed this; inferring it from a
     * timer would be stall detection issuing the verdict §10 denies it.
     *
     * `awaiting_input` rather than `failed`, per §4.1: nothing is broken, the
     * work simply stopped and is waiting for whoever stopped it.
     */
    if (live.session.state === 'working' && live.handles.size === 0) {
      await this.setState(live, 'awaiting_input', 'interrupted; no turn was running');
    }
  }

  // ---------------------------------------------------------------- permissions

  /** Requests currently awaiting a decision, newest last. */
  pendingPermissions(): PermissionRequest[] {
    return [...this.pending.values()].map(({ resolve: _resolve, askedAt: _askedAt, ...req }) => req);
  }

  /**
   * Resolve a pending request. The denial reason is fed back to the agent so it
   * can adapt rather than retrying blindly (§13).
   */
  /**
   * Answer a pending request. **First answer wins.**
   *
   * With several clients attached to one host, two devices can show the same
   * prompt and both be clicked. Throwing on the second would surface an error on
   * a device that did nothing wrong, so a late answer returns
   * `already-answered` and the caller withdraws its prompt instead.
   *
   * `unknown` covers a request this process never had — answered before a
   * restart, or withdrawn. Also not an error: a client that raced a withdrawal
   * should not see a failure for a prompt that simply no longer exists.
   */
  async respondPermission(
    requestId: string,
    decision: PermissionDecision,
    actor?: Actor,
  ): Promise<'answered' | 'already-answered' | 'unknown'> {
    const entry = this.pending.get(requestId);
    if (!entry) {
      // Distinguishable so a UI can say "someone else answered this" rather than
      // "that prompt was never real".
      return this.answered.has(requestId) ? 'already-answered' : 'unknown';
    }
    this.pending.delete(requestId);
    this.answered.add(requestId);

    const live = this.live(entry.sessionId);
    const spec = live.specs.get(entry.agentId);

    await this.logDecision(live, entry, decision, 'user', undefined, actor);
    this.applyGrant(spec, entry, decision);

    entry.resolve(decision);

    // Announced, because the prompt is on more than one screen. A request
    // reaches every attached client, so an answer has to as well — otherwise the
    // device that did not answer keeps showing a question that has already been
    // settled, and only finds out by pressing a button and being told it was too
    // late. §15 names this the criterion that proves the topology, and it is the
    // half that was missing: the ask was broadcast and the answer was not.
    this.emit('permission-resolved', {
      requestId,
      sessionId: entry.sessionId,
      outcome: 'answered' as const,
      decision,
      ...(actor !== undefined ? { actor } : {}),
    });

    // Per session: another session's open prompt must not keep this one parked,
    // and this one's must not be cleared by a sibling being answered.
    if (!this.hasPendingFor(entry.sessionId)) await this.setState(live, 'working');
    return 'answered';
  }

  /**
   * Withdraw every request this session still shows as pending.
   *
   * Called when a session is loaded from disk: the promises those requests were
   * waiting on died with the process that made them, so the agent is not
   * waiting any more. Leaving them in the folded pending set would offer a
   * prompt that does nothing when answered, which is worse than offering none.
   */
  private async withdrawStale(live: LiveSession, outstanding: ReadonlyArray<{ requestId: string; agentId: AgentId }>): Promise<void> {
    for (const request of outstanding) {
      await live.store.append(
        {
          type: 'permission.withdrawn',
          requestId: request.requestId,
          reason: 'the agent that asked is no longer running',
        },
        { agentId: request.agentId },
      );
      // Same reason as an answer: a prompt nobody can answer any more must
      // disappear from every screen showing it, not just from the one that
      // happened to reload.
      this.emit('permission-resolved', {
        requestId: request.requestId,
        sessionId: live.session.sessionId,
        outcome: 'withdrawn' as const,
        reason: 'the agent that asked is no longer running',
      });
    }
  }

  /**
   * Move a seat to a different reasoning effort (§3.4).
   *
   * Refused **by name** on a target that cannot take one, rather than accepted
   * and dropped. `reasoning_effort` is not a field a model without the
   * capability ignores — it is a 400 — so silently storing an effort here would
   * turn every later turn into a failed request, and the person who set it
   * would have no reason to connect the two.
   *
   * Written to the log rather than only to the live object: the projected seat
   * is what a rebuilt spec is made from, and a change that lived in memory
   * would vanish at the next restart while the transcript looked complete.
   */
  async setReasoning(sessionId: SessionId, agentId: AgentId, to: ReasoningRequest): Promise<void> {
    const live = this.live(sessionId);
    const record = live.session.agents.find((a) => a.agentId === agentId);
    if (record === undefined) throw new Error(`no agent ${agentId} in this session`);
    // A retired seat takes no more turns, so an effort set on it is a setting
    // nothing will ever read — and a log line saying the effort changed, at a
    // point after the seat stopped existing, is worse than the refusal (§4.2).
    if (record.status === 'retired') {
      throw new Error(
        `${describeSeat(record)} was retired when this session's model changed, so its ` +
          `reasoning effort no longer applies to anything`,
      );
    }

    if (record.resolvedCapabilities.reasoningControl !== 'effort') {
      throw new Error(
        `${record.spec.model?.modelId ?? record.spec.runtimeId} does not take a reasoning effort`,
      );
    }

    const from = record.spec.reasoning;
    if (from?.mode === to.mode) return;

    record.spec.reasoning = to;
    const spec = live.specs.get(agentId);
    if (spec !== undefined) spec.reasoning = to;

    await live.store.append(
      { type: 'agent.reasoning_changed', ...(from !== undefined ? { from } : {}), to },
      { agentId },
    );
    this.touch(live);
  }

  private contextFor(live: LiveSession, spec: AgentSpec): RuntimeContext {
    // Held, not discarded: the previous version created a controller inline, so
    // the documented cancellation channel could never fire and `wallClockMs` had
    // no mechanism behind it.
    const controller = new AbortController();
    live.aborts.set(spec.agentId, controller);

    return {
      abortSignal: controller.signal,
      reportProgress: (p) => this.emit('progress', live.session.sessionId, p),
      // Into the session's ring, never into the log. The log is the transcript;
      // this is what the process printed, and appending megabytes of a CLI's
      // stdout to a durable record would be a second transcript nobody asked
      // for. Bound to the agent rather than the handle so it outlives the turn.
      reportRaw: (line) => this.keepRaw(live, spec.agentId, line),
      requestPermission: (ask) => this.decide(live, spec, ask),
      sendMessage: (message) => void this.deliver(live, spec.agentId, message),
      /*
       * Live seats only (§4.2).
       *
       * A retired seat stays in the roster so the transcript can name it, but
       * offering it here would hand a model an address that cannot receive:
       * `message` would report a send, nothing would arrive, and the sender
       * would wait for an answer from a model this session no longer runs. The
       * tool's existing refusal — "that agent is not in this session, these
       * are" — is the right sentence, and it needs a truthful roster to say it.
       *
       * In a session created under the cap this is one id, the agent's own, and
       * the tool refuses every address including that one. It is still carried
       * rather than dropped because sessions with two live seats exist.
       */
      peers: activeAgents(live.session).map((a) => a.agentId),
      capture: (o) => this.captureUrl(live, o),
      proposeSplit: (proposal) => void this.proposeSplit(live.session.sessionId, proposal, spec.agentId),
      compact: (budgetTokens) => this.compact(live, spec, budgetTokens),
      /*
       * The cross-session channel, and only for a session that has one (§17 Q22).
       *
       * Both halves or neither, because a way to send with nobody to send to is
       * a guessing game — the argument `peers` already makes for the roster. A
       * session in no group gets neither, and `message_peer` says there is no
       * group rather than reporting a message into an empty room.
       *
       * A snapshot at start, exactly like `peers`: an adapter holds a spec, not
       * a fleet, and a session that joins the group mid-turn is addressable from
       * the next one. The alternative is a list that changes under a model
       * between deciding who to ask and asking.
       */
      ...(live.session.group !== undefined
        ? {
            groupPeers: this.groupPeers(live.session.sessionId).map((s) => ({
              sessionId: s.sessionId as string,
              title: s.title,
            })),
            sendPeerMessage: (message: OutboundPeerMessage) =>
              this.deliverPeer(live, spec.agentId, message),
          }
        : {}),
      // Only when something is actually injected: an empty array would make
      // every runtime merge nothing on every turn for every session.
      ...(live.mcp.size > 0 || live.skills.length > 0
        ? { sessionTools: this.sessionToolsFor(live) }
        : {}),
    };
  }

  /**
   * The session's MCP tools, as closures over connections this manager owns
   * (§17 Q20).
   *
   * Namespaced `mcp__<serverId>__<tool>`, which keeps them out of the
   * built-ins' namespace by construction and gives policy rules a stable name
   * to match. None of these names is in §13's designated-argument table, so an
   * `allow` pattern cannot be written for them and every call falls to the
   * explicit rules or `defaultAction: 'ask'` — fail-closed is the default
   * posture for tools the gate cannot see into.
   *
   * Output passes through the same 8,000-character cap as the built-ins,
   * because §17 Q7's answer *is* that cap: a session tool with unbounded
   * output would reopen the context explosion from outside `tools/index.ts`.
   */
  private sessionToolsFor(live: LiveSession): SessionTool[] {
    const tools: SessionTool[] = [];
    // Skills first (§17 Q21): each is a tool that returns its own body — the
    // model sees the description in the tool list and pays for the
    // instructions only when the work calls for them, which is §17.1's
    // "progressive instruction loading" wearing the suite it already had.
    for (const skill of live.skills) {
      tools.push({
        name: `skill__${skill.id}`,
        description: `Load the "${skill.id}" instructions: ${skill.description}`,
        schema: { type: 'object', properties: {} },
        run: async () => ({
          ok: true,
          summary: `skill ${skill.id} loaded`,
          // Capped at creation, so this passes through whole — the refusal
          // there is what makes no-truncation here a fact and not a hope.
          content: skill.instructions,
        }),
      });
    }
    for (const [serverId, connection] of live.mcp) {
      for (const tool of connection.tools) {
        tools.push({
          name: `mcp__${serverId}__${tool.name}`,
          description: tool.description,
          schema: tool.inputSchema,
          run: async (args, signal) => {
            const result = await connection.call(tool.name, args, signal);
            return {
              ok: result.ok,
              summary: `${serverId}:${tool.name} ${result.ok ? 'ok' : 'failed'}`,
              content: truncateToolOutput(result.text),
            };
          },
        });
      }
    }
    return tools;
  }

  /**
   * Compact one agent's history, on that agent's own initiative (§3.7).
   *
   * The **same `rehydrate()`** the resume path uses, which was the point of the
   * design: the function that reconstructs context after a workspace moves is
   * the function that compacts a running session, so the durable path is
   * exercised every day rather than only in a rare recovery.
   *
   * `null` for an empty result rather than an empty history. A session whose log
   * holds nothing worth carrying is ordinary, and handing back zero turns would
   * erase a conversation to save a window that was not full.
   *
   * The event is written here, not by the caller, for the reason every other
   * event is: the store is the owner's. A transcript that shows a context
   * shrinking with no line saying so reads as a model that forgot things.
   */
  private async compact(
    live: LiveSession,
    spec: AgentSpec,
    budgetTokens: number,
  ): Promise<CompactedHistory | null> {
    const result = await rehydrate(live.store, { budgetTokens });
    if (result.isEmpty) return null;

    const { beforeTokens, afterTokens } = await compactionSizes(live.store, result);
    await live.store.append(
      { type: 'agent.compacted', beforeTokens, afterTokens },
      { agentId: spec.agentId, origin: this.originFor(spec) },
    );
    live.lastEventAt = this.now().getTime();

    return { turns: result.seed, beforeTokens, afterTokens };
  }

  /**
   * Record one agent addressing another, and wake the recipient (§4.2).
   *
   * The log entry is written **whatever happens next** — including when the
   * message is refused for depth, and including a broadcast that wakes nobody.
   * Recording only the delivered ones would make the transcript a record of
   * successful coordination rather than of coordination, and the interesting
   * question when a roster misbehaves is usually what it *tried* to say.
   */
  private async deliver(live: LiveSession, from: AgentId, message: OutboundMessage): Promise<void> {
    const hops = (live.hops.get(from) ?? 0) + 1;
    const stamped: AgentMessage = { ...message, from, hops };

    await live.store.append({ type: 'agent.message', message: stamped }, { agentId: from });
    live.lastEventAt = this.now().getTime();

    if (hops > MAX_MESSAGE_HOPS) {
      await live.store.append(
        {
          type: 'session.state',
          from: live.session.state,
          to: live.session.state,
          reason: `message from ${from} not delivered: ${MAX_MESSAGE_HOPS} hops without a person`,
        },
        { agentId: from },
      );
      return;
    }

    // A broadcast is readable by anyone and wakes no one. Delivering it as a
    // turn would mean one message starting a turn per agent in the roster,
    // which is how a roster of six becomes a fork bomb.
    if (stamped.to === 'session') return;

    const recipient = live.session.agents.find((a) => a.agentId === stamped.to);
    if (recipient === undefined) return;

    live.hops.set(stamped.to, hops);
    // No actor: nobody pressed anything. §5.1 treats an absent actor as "no
    // person acted", and attributing this to whoever happens to be attached
    // would put a name on a turn they never sent.
    void this.send(live.session.sessionId, stamped.to, { content: stamped.content }).catch(
      () => undefined,
    );
  }

  // ------------------------------------------------------------------ groups

  /**
   * Put sessions in a group, so they can message each other (§17 Q22).
   *
   * **Same host, and refused by name otherwise.** The constraint is *this
   * manager*, not this folder: delivery is a lookup in `this.sessions`, so two
   * sessions in different workspaces held by one host group perfectly well and
   * two on different hosts cannot, whatever folders they are in. A session this
   * manager cannot find is one it cannot deliver to, and the only honest thing
   * it can say is which id it does not have. The fleet refuses earlier and more
   * usefully — it can tell a second machine from a second host on this one — but
   * this check is not a duplicate of that: the fleet is a dependency of the app,
   * and a guard that lives only there is a guard the CLI and the next client do
   * not have. §13's rule about a bypassable gate applies to a refusal too.
   *
   * Idempotent per session: joining a group a session is already in appends
   * nothing. The log is a record of changes, and a second identical join would
   * be a change that did not happen.
   *
   * A terminal session may be grouped. It cannot be messaged — delivery refuses
   * it by name — but grouping a finished session is how its transcript sits
   * beside the work that came from it, and refusing would be refusing the
   * ordinary act of tidying up.
   */
  async groupSessions(
    sessionIds: readonly SessionId[],
    name: string,
    groupId?: string,
    actor?: Actor,
  ): Promise<Session[]> {
    if (sessionIds.length === 0) throw new Error('name at least one session to group');
    if (name.trim() === '') {
      // Named rather than defaulted: a group is a thing a person made on
      // purpose, and "Group 4" is a label nobody chose and nobody can find.
      throw new Error('a group needs a name — it is what a person finds it by');
    }

    // Every session resolved *before* anything is written, so a set that is
    // half on this host leaves no session in a group with members it cannot
    // reach. The same rule `spawnChild` follows: a refused split leaves nothing
    // behind.
    const live = sessionIds.map((sessionId) => {
      const found = this.sessions.get(sessionId);
      if (found === undefined) {
        throw new Error(
          `no session ${sessionId} on this host, so it cannot join a group here — ` +
            'a group is delivered inside one host, and messaging between hosts is not built',
        );
      }
      return found;
    });

    const group = { groupId: groupId ?? uuidv7(), name };
    const changed: Session[] = [];
    for (const session of live) {
      if (session.session.group?.groupId === group.groupId) {
        changed.push(session.session);
        continue;
      }
      session.session.group = { ...group };
      await session.store.append(
        { type: 'session.joined_group', groupId: group.groupId, name: group.name },
        { ...(actor !== undefined ? { actor } : {}) },
      );
      // The hint, after the event and never instead of it: a sidebar listing
      // sessions that are *not open* cannot fold a log to label a row, and
      // failing a join because a label could not be written would be the tail
      // wagging the dog (see `writeGroupHint`).
      await session.store.writeGroupHint(group).catch(() => undefined);
      this.touch(session);
      this.emit('session', session.session);
      changed.push(session.session);
    }
    return changed;
  }

  /** Leave a group. A group nobody can leave is a trap, not a feature. */
  async ungroupSession(sessionId: SessionId, actor?: Actor): Promise<Session> {
    const live = this.live(sessionId);
    const group = live.session.group;
    // Not an error: leaving a group you are not in is already the outcome you
    // asked for, and a second client racing the first should not see a failure.
    if (group === undefined) return live.session;

    delete live.session.group;
    await live.store.append(
      { type: 'session.left_group', groupId: group.groupId },
      { ...(actor !== undefined ? { actor } : {}) },
    );
    await live.store.writeGroupHint(null).catch(() => undefined);
    this.touch(live);
    this.emit('session', live.session);
    return live.session;
  }

  /**
   * The other sessions in this session's group, on this host.
   *
   * Derived by asking which sessions carry the id rather than read from a
   * membership record, because there is no membership record — see
   * `Session.group`. One scan of a map this manager already holds.
   */
  groupPeers(sessionId: SessionId): Session[] {
    const group = this.sessions.get(sessionId)?.session.group;
    if (group === undefined) return [];
    return [...this.sessions.values()]
      .map((l) => l.session)
      .filter((s) => s.sessionId !== sessionId && s.group?.groupId === group.groupId);
  }

  /**
   * Carry one session's question to another in its group (§17 Q22).
   *
   * ## Both logs, and each says a different thing
   *
   * The sender's records the **attempt** and the recipient's the **arrival**, so
   * a refused message has an attempt and no arrival and the pair reads as what
   * actually happened. Neither could be derived from the other: two sessions are
   * two directories under `sessions/`, possibly two workspaces, and §5.1's whole
   * bargain is that a log is readable alone. This is §4.3's parent/child rule —
   * *the edge is stored on both ends so either can be reconstructed alone* — in
   * its second application, and the duplication it costs is bounded by
   * `PEER_MESSAGE_MAX_CHARS`, which is one more thing the cap is buying.
   *
   * One event per attempt rather than `deliver`'s two. That method records the
   * message and then, on a refusal, a `session.state` line with the reason,
   * because `agent.message` has nowhere to put one. A new event type could
   * carry the reason, so it does.
   *
   * ## The hop ceiling travels with the message
   *
   * §4.2 bounds an exchange at eight hops without a person because "a lead asks
   * a worker, the worker asks back, and with no ceiling that is a conversation
   * with a bill attached and nobody watching". Two *sessions* doing that is the
   * same conversation with two bills. The count is therefore carried across the
   * boundary and seeded into the recipient's own map, rather than each session
   * starting from zero — which would have made "put them in a group and let them
   * ping-pong" the documented way around the ceiling. A person's turn still
   * clears the count for the session they sent it to, because a human in the
   * loop is exactly what the ceiling is waiting for, and it clears only that
   * session's because that is where the person is.
   *
   * ## What crosses, and what does not
   *
   * Words. Not policy, not the standing grant, not a blob, not a resume token.
   * The recipient runs the resulting turn under its own gate with its own rules
   * (§13), which is what keeps a group from being a way to have work done under
   * somebody else's grant. The sentence added to the framing below is for a
   * person reading the transcript; nothing is enforced by it, because §13 does
   * not delegate gating to a model.
   */
  private async deliverPeer(
    from: LiveSession,
    fromAgentId: AgentId,
    message: OutboundPeerMessage,
  ): Promise<PeerDelivery> {
    const hops = (from.hops.get(fromAgentId) ?? 0) + 1;
    const stamped: PeerMessage = {
      fromSessionId: from.session.sessionId,
      fromAgentId,
      toSessionId: message.toSessionId,
      kind: message.kind,
      text: message.text,
      hops,
    };

    const refuse = async (reason: string): Promise<PeerDelivery> => {
      /*
       * The *recorded* body is bounded even when the attempt is refused for
       * being over the cap.
       *
       * Delivery is refused rather than truncated — that rule is about what the
       * recipient reads, and it stands. But `stamped.text` is whatever the
       * adapter passed, and `RuntimeContext.sendPeerMessage` is reachable
       * without the tool: an adapter running its own loop calls it directly,
       * which is the very reason the cap is checked here as well. Appending the
       * unbounded body meant a model could write megabytes into an append-only
       * log per refused attempt, and repeat — a durable, model-driven, unbounded
       * write that no bound above it stopped, and the exact cost the cap exists
       * to prevent arriving through the refusal path instead of the delivery
       * one.
       *
       * So the evidence is kept and elided rather than dropped: the prefix a
       * person needs to recognise what was attempted, and the true length, which
       * is the part that says *why* it was refused. Nothing here shortens
       * anything that was delivered — over the cap, nothing is.
       */
      const recorded: PeerMessage =
        stamped.text.length <= PEER_MESSAGE_MAX_CHARS
          ? stamped
          : {
              ...stamped,
              text:
                `${stamped.text.slice(0, PEER_MESSAGE_MAX_CHARS)}\n` +
                `[…elided: this attempt was ${stamped.text.length} characters, over the ` +
                `${PEER_MESSAGE_MAX_CHARS}-character cap, and was never delivered]`,
            };
      await from.store.append(
        { type: 'session.peer_message_sent', message: recorded, delivered: false, refusedBecause: reason },
        { agentId: fromAgentId },
      );
      from.lastEventAt = this.now().getTime();
      return { accepted: false, reason };
    };

    // Checked here as well as in the tool, and deliberately: the tool is one
    // caller and this is the owner of the log. A cap enforced only where the
    // model is asked politely is not a cap (§13).
    if (stamped.text.length > PEER_MESSAGE_MAX_CHARS) {
      return refuse(
        `a message to another session is capped at ${PEER_MESSAGE_MAX_CHARS} characters and ` +
          `this one is ${stamped.text.length}; name an artifact instead of pasting it`,
      );
    }

    const group = from.session.group;
    if (group === undefined) return refuse('this session is not in a group');

    if (hops > MAX_MESSAGE_HOPS) {
      return refuse(
        `not delivered: ${MAX_MESSAGE_HOPS} hops without a person. ` +
          'Ask whoever is watching this run before continuing the exchange.',
      );
    }

    if (stamped.toSessionId === from.session.sessionId) {
      return refuse('a session cannot message itself');
    }

    const to = this.sessions.get(stamped.toSessionId as SessionId);
    if (to === undefined) {
      /*
       * Refused by name rather than routed. This manager owns one workspace, so
       * a session it does not hold is either not loaded or on another machine —
       * and v1 does not cross machines. Saying so is the project's habit (§16's
       * execution-target failure, `applyTemplate`'s refusal, `hostFor`'s): the
       * alternative is silence, and silence here looks exactly like a message
       * that was delivered and ignored.
       */
      return refuse(
        `no session ${stamped.toSessionId} on this host — messaging between sessions on ` +
          'different machines is not built, so both must be in the same workspace host',
      );
    }
    if (to.session.group?.groupId !== group.groupId) {
      return refuse(
        `session ${stamped.toSessionId} is not in your group, and a message may only reach ` +
          'a session that is',
      );
    }
    /*
     * A finished session is refused; a paused one is not.
     *
     * The distinction is the one this whole design is built on (§4.1): the
     * `awaiting_*` states mean *paused, holding all state, will resume*, so a
     * message to a session waiting on quota or on a person is queued and runs
     * when it wakes — turning that into a refusal would treat a pause as a
     * failure in the one place it is easiest to. `done`, `failed` and
     * `cancelled` are genuinely over, and waking one would resurrect work
     * somebody closed.
     */
    if (isTerminal(to.session.state)) {
      return refuse(
        `session ${stamped.toSessionId} is ${to.session.state} — it is finished, and a message ` +
          'would not be worked on',
      );
    }
    /*
     * The recipient's live agent, which is its only agent (§4.2).
     *
     * `agents[0]` was right while a roster could only grow, and became wrong
     * when a seat could be *replaced*: seat zero of a session whose model was
     * changed is the retired one, and a peer message delivered to it would be
     * accepted here and then refused by `send` — reported as delivered in one
     * log with nothing arriving in the other, which is precisely the pair §17
     * Q22 says must always agree.
     */
    const recipient = activeAgents(to.session)[0];
    if (recipient === undefined) {
      return refuse(
        `session ${stamped.toSessionId} has no agent to work on this. ` +
          'Nothing there would read it.',
      );
    }

    await from.store.append(
      { type: 'session.peer_message_sent', message: stamped, delivered: true },
      { agentId: fromAgentId },
    );
    await to.store.append({ type: 'session.peer_message_received', message: stamped });
    from.lastEventAt = this.now().getTime();
    to.lastEventAt = this.now().getTime();

    // Seeded before the turn starts, so the reply this may provoke counts as
    // the next hop of the same exchange rather than the first of a new one.
    to.hops.set(recipient.agentId, hops);

    /*
     * The recipient's lead, not an agent the sender named.
     *
     * Addressing an agent inside another session would mean reaching into a
     * roster the sender cannot see and which changes without it — §4.2's "the
     * roster is carried, not discovered" problem, made worse by a boundary. A
     * session has a stable id, a title and a goal; who answers is its own
     * business.
     *
     * No actor, for `deliver`'s reason: nobody pressed anything, and §5.1 reads
     * an absent actor as "no person acted".
     */
    void this.send(to.session.sessionId, recipient.agentId, {
      content: [
        {
          type: 'text',
          text:
            `[${stamped.kind} from the session "${from.session.title}" ` +
            `(${from.session.sessionId}) in your group "${group.name}"]\n\n` +
            `${stamped.text}\n\n` +
            `Answer with message_peer to ${from.session.sessionId} if a reply is wanted. ` +
            'You are working in your own session, under its own permissions and scope.',
        },
      ],
    }).catch(() => undefined);

    return { accepted: true };
  }

  /**
   * Put an unmerged branch on the checklist (§9).
   *
   * Never merged automatically. A worktree is a branch and the merge is the
   * user's call: an automatic `git merge` either conflicts at an inconvenient
   * moment or, worse, does not — and lands work nobody reviewed. A visible
   * unfinished item is the honest shape for "this agent produced something you
   * have not accepted yet".
   *
   * Idempotent by item id, so a five-turn agent contributes one line rather than
   * five. Re-appended each turn on purpose: the text carries the commit state,
   * and an item that stopped being true after the first turn would be worse than
   * no item at all.
   */
  private async surfaceMerge(live: LiveSession, agentId: AgentId): Promise<void> {
    const worktree = live.worktrees.get(agentId);
    if (worktree === undefined) return;
    if (!(await hasCommits(this.rootOf(live), worktree))) return;

    await live.store.append(
      {
        type: 'checklist.updated',
        itemId: `merge:${worktree.branch}`,
        state: 'todo',
        text: `merge ${worktree.branch} into ${worktree.base}`,
      },
      { agentId },
    );
  }

/**
   * Scale a stored image down for an agent that cannot take it whole (§12.2).
   *
   * Reads the blob, scales, and stores the result as a *new* blob — the original
   * is never replaced. §12.3 makes that rule explicit for annotations and the
   * same reasoning applies here: what was attached has to stay recoverable, and
   * a second agent with a larger limit should get the full-size image rather
   * than whatever the first agent's ceiling left behind.
   *
   * `null` on anything at all — an unreadable blob, a format this cannot decode.
   * `fitContent` turns that into a named downgrade, which is the honest outcome:
   * the image is not sent, and the model is told why.
   */
  private async rescale(
    live: LiveSession,
    image: { sha256: string; mime: string },
    maxLongEdge: number,
  ): Promise<{ sha256: Sha256; width: number; height: number } | null> {
    try {
      const original = await live.store.blobs.get(image.sha256 as Sha256, image.mime);
      const scaled = await scaleToFit(original, maxLongEdge);
      const { width, height } = sizeOf(scaled);
      const stored = await live.store.attach(scaled, image.mime);
      return { sha256: stored.sha256 as Sha256, width, height };
    } catch {
      return null;
    }
  }

/**
   * Draw a turn's annotations onto its image and store the result (§12.3).
   *
   * A *new* blob every time, never a replacement. §12.3: annotations "stay
   * editable and the original is never destroyed" — and the original is what
   * `annotatedFrom` points back at, so overwriting it would break the link and
   * the promise in one move.
   *
   * Blackouts never reach here. They went through `redactAndStore` before the
   * frame was written, because deferring one would leave the secret sitting in a
   * content-addressed store that §6.7 will push on request — §12.1's guarantee,
   * which §12.3 explicitly must not undo.
   *
   * `null` rather than a throw when there is no decoder: a missing painter costs
   * the marks, not the message. The description travels either way, and §12.3
   * says that is often the only part a weaker model reads.
   */
  private async burnAnnotations(
    live: LiveSession,
    image: { sha256: string; mime: string },
    annotations: readonly Annotation[],
  ): Promise<{ sha256: Sha256 } | null> {
    try {
      const original = await live.store.blobs.get(image.sha256 as Sha256, image.mime);
      const painted = await flattenAnnotations(original, annotations);
      const stored = await live.store.attach(painted, image.mime);
      return { sha256: stored.sha256 as Sha256 };
    } catch {
      return null;
    }
  }

  /**
   * Screenshot a URL and store it in this session's blobs (§12.1).
   *
   * Here rather than in the adapter for the same reason fitting is: the blob
   * store belongs to the owner of the log. An adapter handed raw bytes would
   * either have to write them somewhere it does not own or hold a screenshot in
   * memory for the rest of the turn.
   *
   * Provenance is recorded in full — url, viewport, which browser — because §12.1
   * asks for it and because a rendering difference between two captures is
   * unattributable without it.
   */
  private async captureUrl(
    live: LiveSession,
    o: { url: string; viewport?: { width: number; height: number; dpr: number } },
  ): Promise<ImageBlock> {
    const shot = await captureUrl(o.url, { ...(o.viewport !== undefined ? { viewport: o.viewport } : {}) });
    const { width, height } = sizeOf(shot.png);
    const stored = await live.store.attach(shot.png, 'image/png');

    return {
      type: 'image',
      sha256: stored.sha256 as Sha256,
      mime: 'image/png',
      width,
      height,
      provenance: {
        kind: 'headless_browser',
        // §12.1: both remote sources are tagged this way. The pixels were
        // produced by the machine running the work, not by the person watching.
        origin: 'remote',
        capturedAt: this.now().toISOString(),
        url: shot.url,
        viewport: { w: shot.viewport.width, h: shot.viewport.height, dpr: shot.viewport.dpr },
      },
    };
  }

  /** Provenance for events attributable to an agent (§5.1). */
  private originFor(spec: AgentSpec | Omit<AgentSpec, 'workspacePath'>): EventOrigin {
    const runtime = this.deps.registry.has(spec.runtimeId)
      ? this.deps.registry.get(spec.runtimeId)
      : null;
    return {
      runtimeId: spec.runtimeId,
      adapterVersion: runtime?.version ?? 'unknown',
      ...(runtime?.toolVersion !== undefined ? { cliVersion: runtime.toolVersion } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
    };
  }

  /**
   * The gate. Policy is consulted first; only an `ask` outcome reaches the user.
   * An unresolvable request parks the session in `awaiting_permission` — paused,
   * holding state, never failed.
   *
   * Every outcome is logged, including the ones policy settles without a prompt.
   */
  private async decide(
    live: LiveSession,
    spec: AgentSpec,
    ask: PermissionAsk,
  ): Promise<PermissionDecision> {
    // The workspace root is what makes §13's inside/outside rows evaluable.
    const evaluation = evaluatePolicy(spec.toolPolicy, ask.tool, ask.args, {
      workspaceRoot: this.rootOf(live),
    });

    const request: PermissionRequest = {
      ...ask,
      sessionId: live.session.sessionId,
      // Host-minted. An adapter-minted id collided across parallel calls, so a
      // decision could be applied to a different call than the one displayed.
      requestId: `${ask.agentId}:${ask.toolUseId ?? uuidv7()}`,
    };

    if (evaluation.outcome !== 'ask') {
      const decision: PermissionDecision =
        evaluation.outcome === 'allow'
          ? { result: 'allow', scope: 'once' }
          : {
              result: 'deny',
              reason:
                evaluation.reason ??
                (evaluation.rule?.match
                  ? `denied by policy: ${evaluation.rule.tool}(${evaluation.rule.match})`
                  : `denied by policy: ${ask.tool}`),
            };

      await this.logDecision(
        live,
        request,
        decision,
        evaluation.nonOverridable ? 'escalation-guard' : 'policy',
        evaluation,
      );
      return decision;
    }

    /*
     * The standing grant settles the question and only the question (§17 Q19).
     *
     * It is checked after policy has answered, and only an `ask` reaches it:
     * a policy `deny` and the escalation guard are refusals, not questions,
     * and they stand exactly as they would without the grant. The decision is
     * still written per call — `via: 'standing-grant'`, never `'policy'`,
     * because "the workspace policy allows writes here" and "a person said
     * yes to everything up front" are different claims about who is
     * answerable. Scope `once`: the grant does not widen the agent's policy,
     * so revoking it is nothing more than the session ending.
     */
    if (live.session.standingGrant !== undefined) {
      const decision: PermissionDecision = { result: 'allow', scope: 'once' };
      await this.logDecision(live, request, decision, 'standing-grant', evaluation);
      return decision;
    }

    if (this.pending.has(request.requestId)) {
      // Overwriting would drop the first promise and wedge that turn forever.
      throw new Error(`duplicate permission request id ${request.requestId}`);
    }

    // Durable *before* the prompt exists. The waiting promise lives in this
    // process, but the record of what is being asked does not — that is what
    // lets any attached client see the request and answer it, and what lets a
    // reloaded session know a request was outstanding at all (§7, §16).
    await live.store.append(
      {
        type: 'permission.requested',
        requestId: request.requestId,
        tool: request.tool,
        args: request.args,
        ...(request.toolUseId !== undefined ? { toolUseId: request.toolUseId } : {}),
      },
      { agentId: request.agentId, origin: this.originFor(spec) },
    );

    await this.setState(live, 'awaiting_permission');

    /**
     * Hand the concurrency slot back while a person is being waited for (§8).
     *
     * Found by CI on a small runner, not by reading: `defaultTurnCap()` is
     * `min(8, cores − 2)`, which is **1** on any machine with three cores or
     * fewer — a modest VM, a CI runner, a Raspberry Pi. Holding the slot across
     * a prompt meant one unanswered question stopped every agent on the host,
     * on every session, until a human came back. Every development machine here
     * has four cores or more, so it passed everywhere it was ever run.
     *
     * The argument for holding it was that the worker is resident and costs
     * memory whether or not anyone has answered. True, and outweighed twice
     * over: a prompt can go unanswered for hours — that is the whole premise of
     * §11's inbox — and the design already makes this exact call one line above
     * the acquisition, where a quota wait sits *outside* the slot because
     * "waiting on a shared allowance costs this host nothing". Waiting on a
     * person costs it nothing either.
     *
     * The cost is that resuming queues again rather than continuing instantly.
     * That is the correct price: a turn that has been idle for an hour has no
     * claim on the machine ahead of one that has been waiting to start.
     */
    const holder = this.turnSlots.get(request.agentId);
    holder?.release();

    try {
      return await new Promise<PermissionDecision>((resolve) => {
        this.pending.set(request.requestId, {
          ...request,
          askedAt: this.now().toISOString(),
          resolve,
        });
        this.emit('permission', request);
      });
    } finally {
      // Retaken before the tool runs, so the work that follows an answer is
      // still bounded by the cap. Reassigned rather than returned, so the
      // `finally` in `send` releases whichever slot is current.
      if (holder !== undefined) {
        holder.release = await this.acquireSlot(live, spec);
      }
    }
  }

  /** Take a slot, explaining the wait if there is one. */
  private async acquireSlot(live: LiveSession, spec: AgentSpec): Promise<() => void> {
    return this.slots.acquire((position) =>
      this.contextFor(live, spec).reportProgress({
        kind: 'phase',
        detail: `queued behind ${position} turn${position === 1 ? '' : 's'} on this machine`,
        at: this.now().toISOString(),
      }),
    );
  }

  private async logDecision(
    live: LiveSession,
    request: PermissionRequest,
    decision: PermissionDecision,
    via: 'policy' | 'user' | 'escalation-guard' | 'standing-grant',
    evaluation?: { rule: PolicyRule | null; subject: string | null },
    /** Only ever set when `via` is `'user'` — policy is not a person. */
    actor?: Actor,
  ): Promise<void> {
    const spec = live.specs.get(request.agentId);
    await live.store.append(
      {
        type: 'permission.decided',
        requestId: request.requestId,
        tool: request.tool,
        args: request.args,
        decision,
        via,
        ...(evaluation?.rule ? { rule: evaluation.rule } : {}),
        ...(evaluation ? { subject: evaluation.subject } : {}),
        ...(request.toolUseId !== undefined ? { toolUseId: request.toolUseId } : {}),
      },
      {
        agentId: request.agentId,
        // "Which agent tried that" needs the runtime and model, not just an id.
        ...(spec ? { origin: this.originFor(spec) } : {}),
        // The question this whole field exists to answer: with several people
        // attached to one host, "the gate said yes" is not an answer to "who
        // let it run that".
        ...(actor !== undefined ? { actor } : {}),
      },
    );
  }

  /**
   * Apply a durable grant to the *asking agent* only. A session-wide grant would
   * widen siblings that may be on a less trusted runtime (§13).
   */
  private applyGrant(
    spec: AgentSpec | undefined,
    request: PermissionRequest,
    decision: PermissionDecision,
  ): void {
    if (!spec || decision.result !== 'allow') return;
    if (decision.scope === 'once') return;

    spec.toolPolicy.rules.push(
      decision.scope === 'pattern'
        ? { tool: request.tool, match: decision.match, action: 'allow' }
        : { tool: request.tool, action: 'allow' },
    );
  }

  private hasPendingFor(sessionId: SessionId): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Why a turn stopped, in words the person reading them can act on.
   *
   * `stopReasonSummary` is the shared, location-blind half; this adds the one
   * fact only the owner of the workspace has. It matters for exactly one stop:
   * `auth` parks the session in `awaiting_credentials` (§4.1) holding all its
   * state, and the *whole* value of that pause is that somebody fixes the
   * credential and sends again. A remedy is a command plus a machine, and a
   * seat whose CLI lives on a build box telling you to log in — with your own
   * laptop in front of you — is an instruction that quietly does not work.
   *
   * Everything else is left alone deliberately: a rate limit or a spent window
   * is not fixed by going anywhere, so naming a machine there would be noise on
   * every row to make one row right.
   */
  private stopReason(stop: StopReason, live: LiveSession): string {
    const summary = stopReasonSummary(stop);
    if (stop.kind !== 'auth') return summary;
    const machine = this.deps.machineName ?? hostname();
    // The session's own workspace, not the host's first one: a remedy naming
    // the wrong folder on the right machine is the same class of unusable
    // instruction as one naming the wrong machine.
    return (
      `${summary} (machine: ${machine}, workspace: ${this.rootOf(live)}). ` +
      `Nothing is lost — the session is holding its work and picks this turn up when you send again.`
    );
  }

  private async setState(live: LiveSession, to: SessionState, reason?: string): Promise<void> {
    if (live.session.state === to) return;
    const from = live.session.state;

    /**
     * A parent cannot finish while a descendant is still working (§4.3).
     *
     * `awaiting_children` is one of the `awaiting_*` family: paused, holding all
     * state, will resume. Letting a parent reach `done` with live children would
     * mark the work finished while some of it is still running, and a dashboard
     * that says done is the one thing nobody looks at again.
     */
    const settled = to === 'done' || to === 'awaiting_input';
    live.session.state = settled && this.hasActiveChildren(live) ? 'awaiting_children' : to;
    // Through `ownAttention`, not `attentionFor` directly: a pending split
    // proposal has to survive the states underneath it. Deriving from state
    // alone dropped the question the moment the next turn ended.
    live.session.needsAttention = this.ownAttention(live);
    this.touch(live);
    this.rollUp(live);

    await live.store.append({
      type: 'session.state',
      from,
      to,
      ...(reason !== undefined ? { reason } : {}),
    });

    // A finished session has no more turns to serve tools to, and an MCP
    // server is a running process: keeping it alive past `done` would be a
    // child process owned by nothing anyone can see (§17 Q20).
    if (isTerminal(live.session.state)) {
      for (const connection of live.mcp.values()) connection.dispose();
      live.mcp.clear();
    }

    this.emit('state', live.session.sessionId, to, from);
  }

  /**
   * A session said something, so it is not stuck.
   *
   * Clearing on the *first* event rather than on a turn ending is what makes
   * `stalled` reversible. A long turn that goes quiet and then resumes was never
   * stuck, and a warning that stays up after the thing it warned about resolved
   * is how a signal stops being read.
   */
  private spoke(sessionId: SessionId): void {
    const live = this.sessions.get(sessionId);
    if (live === undefined) return;
    live.lastEventAt = this.now().getTime();
    if (live.session.needsAttention?.reason === 'stalled') {
      live.session.needsAttention = null;
      this.emit('session', live.session);
      // And up, so a warning that resolved stops showing at the root too. A
      // summons left standing after the thing it pointed at cleared is how the
      // rail stops being read.
      this.rollUp(live);
    }
  }

  /**
   * Mark sessions that have gone silent mid-turn.
   *
   * A **suspicion, not a verdict**: the state stays `working`, because that is
   * what it is — an agent may legitimately be slow, and moving it to a paused or
   * failed state would claim something untrue about work still in flight and
   * would have to be undone the moment it spoke again. `needsAttention` exists
   * precisely to say "a person should look" without asserting what happened.
   *
   * Only sessions that are `working`. A paused one is waiting for a human by
   * design, which is a different thing with its own reason, and calling that
   * stalled would flag every session anybody ever left overnight.
   */
  /**
   * Put parked sessions back to work once their window has reset.
   *
   * The turn is re-sent rather than the session merely being unpaused. §15's
   * criterion is that a quota-exhausted agent "parks and resumes on its own at
   * reset", and returning it to `awaiting_input` would mean the work only
   * continues if a human happens to notice and retype it — which is the thing
   * parking exists to avoid.
   *
   * Re-running a turn can repeat side effects it already had. That is the same
   * bargain the supervisor already makes for `rate_limited`, on a longer clock,
   * and the alternative is worse: work abandoned in the middle because nobody
   * was watching at 4am. The repeat is announced in the log so a transcript
   * showing the same turn twice explains itself.
   */
  private sweepParked(): void {
    const now = this.now().getTime();

    for (const live of this.sessions.values()) {
      const parked = live.parked;
      if (parked === undefined || now < parked.resetsAt) continue;

      // Cleared first: `send` runs the turn, and a park still set would be
      // waiting to fire again on the very next sweep.
      delete live.parked;

      void (async () => {
        try {
          await live.store.append({
            type: 'session.unparked',
            reason: 'quota-window-reset',
            parkedFor: new Date(parked.resetsAt).toISOString(),
          });
          await this.send(live.session.sessionId, parked.agentId, parked.turn, parked.actor);
        } catch {
          // A failed resume leaves the session where the failure put it. Parking
          // again on a window that has already reset would spin.
        }
      })();
    }
  }

  private sweepStalled(): void {
    const after = this.deps.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    if (after <= 0) return;
    const now = this.now().getTime();

    for (const live of this.sessions.values()) {
      if (live.session.state !== 'working') continue;
      if (live.session.needsAttention !== null) continue;
      // Queued behind a shared credential is not stuck. It is the scheduler
      // doing exactly what it exists to do, and flagging it would teach the user
      // to ignore the one signal that means something.
      if (live.waitingOnQuota.size > 0) continue;
      if (now - live.lastEventAt < after) continue;

      live.session.needsAttention = {
        reason: 'stalled',
        since: new Date(live.lastEventAt).toISOString(),
      };
      this.emit('session', live.session);
      // Bubbled like any other blockage. A stalled grandchild that only showed
      // on its own card is exactly the thing §4.3 says nobody will ever find.
      this.rollUp(live);
    }
  }

  private touch(live: LiveSession): void {
    live.session.updatedAt = this.now().toISOString();
    this.emit('session', live.session);
  }

  private live(sessionId: SessionId): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new UnknownSession(sessionId);
    return live;
  }

  private agent(live: LiveSession, agentId: AgentId): AgentRecord {
    const record = live.session.agents.find((a) => a.agentId === agentId);
    if (!record) throw new Error(`unknown agent ${agentId}`);
    /*
     * A retired seat is still in the roster and still not sendable (§4.2).
     *
     * It has to stay findable — the transcript names it on every row it wrote —
     * but a turn addressed to it would be a turn on a model this session no
     * longer runs, which is precisely what the cap exists to prevent. The
     * likeliest sender is a client that had the old id in hand when the model
     * changed, so the message says what happened and what to do.
     */
    if (record.status === 'retired') {
      const now = activeAgents(live.session)[0];
      throw new Error(
        `${describeSeat(record)} was retired when this session's model changed` +
          (now !== undefined ? `; it now runs ${describeSeat(now)}` : '') +
          ` — reload the session and send again`,
      );
    }
    return record;
  }

  /**
   * Whether a session can already resolve a hash, sourcing it from a sibling
   * session on this host if one can (§6.7).
   *
   * The transfer is driven from the client side — the client is what holds the
   * bytes and therefore what has to decide whether to send them — but the answer
   * belongs here, because the store does.
   */
  async hasBlob(sessionId: SessionId, sha256: Sha256, mime: string): Promise<boolean> {
    // Throws on an unknown session rather than answering `false`, which would
    // read as "send it to me" and then fail on the write.
    const live = this.live(sessionId);
    return ensureBlob(this.rootOf(live), sessionId, sha256, mime);
  }

  /**
   * Read stored bytes back (§12).
   *
   * The blob store has carried images since captures existed and nothing could
   * ask for them back — `blob.has` and `blob.put` send bytes *to* a host, and
   * there was no way home. So a screenshot a tool produced was visible to the
   * model and to nobody else: stored, hashed, referenced in the log, and
   * undrawable.
   *
   * `mime` is optional because the callers that need this often do not know it.
   * `agent.tool_result` records a `resultSha256` and no type, so the store's own
   * recovery scan — which finds `<sha>.*` — is what makes those reachable at
   * all. Null rather than throwing for a blob that is simply not here: a log can
   * outlive the bytes it references, and a missing picture is a thing to say
   * rather than an error to raise.
   */
  async readBlob(sessionId: SessionId, sha256: Sha256, mime?: string): Promise<Buffer | null> {
    const live = this.live(sessionId);
    const blobs = live.store.blobs;
    try {
      if (mime !== undefined) return await blobs.get(sha256, mime);
      const path = await blobs.locate(sha256);
      return path === null ? null : await readFile(path);
    } catch {
      return null;
    }
  }

  /**
   * Store verified bytes against a session (§6.7).
   *
   * `attach` rather than `put`, and the difference is the log: the bytes land in
   * the store *and* a `capture.attached` event lands in the transcript. A blob
   * that arrived without a trace would be unattributable the moment anybody
   * asked where a screenshot came from — which for a screenshot is the question
   * that gets asked.
   */
  async attachBlob(sessionId: SessionId, data: Buffer, mime: string): Promise<Sha256> {
    const { sha256 } = await this.live(sessionId).store.attach(data, mime);
    return sha256 as Sha256;
  }

  /** Tail the durable log for a session — the renderer's subscription source. */
  async events(sessionId: SessionId, fromSeq = 0): Promise<AgbrteEvent[]> {
    return this.live(sessionId).store.readEvents(fromSeq);
  }

/**
   * Split a session's scope into a child that owns its own log (§4.3).
   *
   * The expensive form of decomposition, and deliberately so: a new log, its own
   * plan, its own agents, its own budget. §4.3's decision rule is that this is
   * for when *the task* does not fit — where compacting would discard specifics
   * the remaining work still needs — not for when the transcript is merely long.
   *
   * ## Everything here is a refusal before it is an action
   *
   * §4.3 keeps splits user-approved because "a decomposition mistake made
   * autonomously produces a tree of subtly mis-scoped children that is harder to
   * salvage than a single overlong session". The same reasoning applies to every
   * check below: a child spawned past a limit, or on a budget its parent cannot
   * cover, is worse than a spawn that did not happen — the first costs money and
   * attention before anyone notices, the second says why immediately.
   *
   * `buildBrief` supplies its own refusals (empty scope, empty `outOfScope`, no
   * summary ceiling, a brief over its own ceiling). This adds the ones that are
   * about the *tree* rather than the brief.
   *
   * ## The edge is written on both ends
   *
   * The parent records `session.spawned_child`, the child records
   * `session.brief_received`. Either log alone can reconstruct the relationship,
   * which is what makes a child in another workspace — the case §4.3 is built
   * for — self-contained rather than a dangling reference.
   */
  async spawnChild(
    parentSessionId: SessionId,
    input: SpawnChildInput,
    actor?: Actor,
  ): Promise<Session> {
    const prepared = await this.prepareChild(parentSessionId, input);
    const child = await this.createSession(prepared.create, actor);
    this.live(child.sessionId).contract = input.contract;
    await this.recordChild(parentSessionId, child, prepared.parentBudget, input.contract, actor);
    return this.live(child.sessionId).session;
  }

  /**
   * Everything a spawn decides *before* anything changes (§4.3).
   *
   * Split out because the three steps of a spawn happen on two machines once a
   * child can live elsewhere: this one on the parent's host, the creation on the
   * target's, and `recordChild` back on the parent's. Keeping them one method
   * meant the middle step could only ever be `this.createSession`.
   *
   * **Nothing here mutates.** Every refusal is raised, the reservation is
   * computed, the brief is built — and the parent's budget is untouched until
   * `recordChild`. That ordering is what makes a distributed spawn safe without
   * a two-phase commit: a creation that fails leaves no debit behind, because
   * the debit had not happened.
   */
  async prepareChild(
    parentSessionId: SessionId,
    input: SpawnChildInput,
  ): Promise<{ create: CreateSessionInput; parentBudget: SessionBudget }> {
    const parent = this.live(parentSessionId);

    // Depth first, because it is the cheapest thing to be wrong about and the
    // one that says the decomposition itself is off (§4.3: "deeper trees are
    // unmanageable and almost always signal bad decomposition, not deep work").
    const depth = parent.session.tree.depth + 1;
    if (depth > TREE_LIMITS.maxDepth) {
      throw new SplitRefused(
        `maxDepth is ${TREE_LIMITS.maxDepth} and this child would sit at ${depth}; ` +
          `a tree this deep is usually a sign the split is wrong rather than deep work`,
      );
    }
    if (parent.session.children.length >= TREE_LIMITS.maxChildrenPerSession) {
      throw new SplitRefused(
        `this session already has ${parent.session.children.length} children, ` +
          `which is the limit that keeps a tree node reviewable by a human`,
      );
    }

    /*
     * A child runs where it was created, and now that can be elsewhere.
     *
     * This refused a differing `target` by name for a long time, and the
     * refusal was right while it lasted: `spawnChild` created the child through
     * `this.createSession` — *this* manager, one workspace, one host — so a
     * `target` naming another machine set a field and changed nothing. The log
     * said `ssh` while the agent worked locally, which is worse than the
     * feature being absent: an absent feature is noticed, and that one was only
     * noticed by whoever later trusted the field.
     *
     * What lifts it is not this method. `prepareChild` decides without
     * mutating, `createSession` takes the inherited position and brief, and
     * `recordChild` commits — so the fleet can run the three against two hosts
     * (§17 Q5). Reached here, both halves are on one machine and there is
     * nothing to route.
     */
    const budget = parent.session.budget;
    if (budget === undefined) {
      // A parent with no ceiling cannot carve one out, and inventing one would
      // put a number nobody agreed to at the root of a subtree.
      throw new SplitRefused('this session has no budget, so nothing can be reserved for a child');
    }

    // Taken *before* the child exists. §4.3's claim that "a tree cannot outspend
    // what its root was granted" only holds if the reservation happens at spawn
    // rather than being checked when the child spends — by then the money is
    // gone and the check is a report.
    const reserved = reserveForChild(budget, input.tokenCeiling);

    const built = await buildBrief(parent.store, {
      scope: input.scope,
      outOfScope: input.outOfScope,
      contract: input.contract,
      acceptance: input.acceptance ?? [],
      budget: reserved.child,
      ...(input.memoryRefs !== undefined ? { memoryRefs: input.memoryRefs } : {}),
      ...(input.verbatimTurns !== undefined ? { verbatimTurns: input.verbatimTurns } : {}),
    });

    return {
      parentBudget: reserved.parent,
      create: {
        title: input.title,
        goal: input.scope,
        /**
         * The parent's policy, copied (§13).
         *
         * > A child **never inherits more permission than its parent held** …
         * > so "decompose the work" can never be a route to escalating
         * > privilege.
         *
         * Without this the child took `defaultPolicyForTarget`, so a parent
         * that had been *narrowed* — bash denied, say — produced a child with
         * the permissions back. Splitting was a way to undo a restriction, which
         * is the one thing this section says it must never be.
         *
         * A copy rather than the object, for the reason `addAgent` copies: a
         * grant made in the child would otherwise widen the parent, and every
         * sibling with it.
         *
         * The parent's `standingGrant` is deliberately *not* here (§17 Q19).
         * A child is its own session and starts asking again: inheriting
         * would make one decision at the root silently govern work the person
         * granting it had not seen.
         */
        policy: clonePolicy(parent.policy),
        budget: reserved.child,
        /*
         * Passed in rather than patched on afterwards.
         *
         * This used to create the session and then reach into it — `const live =
         * this.live(child.sessionId); live.session.tree = …` — which works only
         * because the child happens to be in *this* manager's map. Handing the
         * inherited position and brief to whoever creates the session is what
         * lets the same code create it on another host, and it removes a window
         * where a child existed with a root's tree and no brief.
         */
        child: {
          tree: {
            rootSessionId: parent.session.tree.rootSessionId,
            parentSessionId,
            depth,
            // Root-first, and carrying the parent: this is what a breadcrumb
            // renders from and what stops a cycle being createable at all.
            ancestry: [...parent.session.tree.ancestry, parentSessionId],
          },
          brief: built.brief,
          ...(input.contract !== undefined ? { contract: input.contract } : {}),
        },
        ...(input.target !== undefined ? { target: input.target } : {}),
      },
    };
  }

  /**
   * Commit the spawn on the parent: the debit, the reference, the event (§4.3).
   *
   * The only step that changes the parent, and it runs after the child exists —
   * so a creation that failed costs nothing, and `prepareChild` can be called
   * against a host that never ends up hosting anything.
   */
  async recordChild(
    parentSessionId: SessionId,
    child: Session,
    parentBudget: SessionBudget,
    contract: ResultContract,
    actor?: Actor,
  ): Promise<void> {
    const parent = this.live(parentSessionId);

    const ref: ChildRef = {
      sessionId: child.sessionId,
      instanceId: child.instanceId,
      target: child.target,
      title: child.title,
      contract,
      // Read from the child as it was handed over, not from a live session: for
      // a child on another host there is no local object to read.
      lastKnown: {
        state: child.state,
        checklistDone: 0,
        checklistTotal: 0,
        updatedAt: child.updatedAt,
        cost: 0,
      },
    };

    parent.session.budget = parentBudget;
    parent.session.children.push(ref);
    await parent.store.append(
      { type: 'session.spawned_child', child: ref },
      { ...(actor !== undefined ? { actor } : {}) },
    );

    this.emit('session', parent.session);
  }

/**
   * Push this session's state up to its parent, and bubble what is blocked.
   *
   * Two things travel up and they are different in kind. `lastKnown` is a
   * **cache** for rendering a tree whose children may be unreachable — §4.3 is
   * explicit that it is "never authoritative". `needsAttention` is a **summons**:
   * §4.3 calls bubbling "the single most important tree behavior in the UI",
   * because a child three levels down waiting on a permission prompt is the
   * easiest thing in the system to lose. A parent sitting in `awaiting_children`
   * looks patient; the question underneath it goes unanswered forever.
   *
   * Walks to the root rather than one level, since the rail is at the top and a
   * blockage that stopped at the parent would still be two expansions away.
   *
   * **Within this host only.** A tree spanning two workspaces has an edge no
   * `SessionManager` can see across, and §4.3 already names this as open: the
   * fleet, or the host owning the root, has to carry it. Bubbling as far as one
   * manager reaches is honest; pretending otherwise would put a rail on screen
   * that silently omits half a tree.
   */
  private rollUp(live: LiveSession): void {
    const parentId = live.session.tree.parentSessionId;
    if (parentId === undefined) return;
    const parent = this.sessions.get(parentId as SessionId);
    if (parent === undefined) return;

    const ref = parent.session.children.find((c) => c.sessionId === live.session.sessionId);
    if (ref !== undefined) {
      ref.lastKnown = {
        state: live.session.state,
        checklistDone: live.session.checklist.filter((i) => i.state === 'done').length,
        checklistTotal: live.session.checklist.length,
        updatedAt: live.session.updatedAt,
        cost: totalCost(live.session),
      };
    }

    // Recomputed from scratch rather than patched. A parent whose own state also
    // changed, or whose child just cleared, has to be able to *lose* a bubbled
    // attention — and an incremental update that only ever adds is how a stale
    // summons stays on screen after the thing it pointed at was answered.
    this.recomputeAttention(parent);
    this.rollUp(parent);
  }

  /** Whether anything below this session is still working. */
  private hasActiveChildren(live: LiveSession): boolean {
    return live.session.children.some((c) => !isSettled(c.lastKnown.state));
  }

  /**
   * A session's own blockage, or the nearest one beneath it.
   *
   * Its own wins. A parent that is itself waiting on a permission prompt is not
   * helped by being told a grandchild is too — the thing in front of you is the
   * thing you can answer.
   */
  private recomputeAttention(parent: LiveSession): void {
    const own = this.ownAttention(parent);
    if (own !== null) {
      parent.session.needsAttention = own;
      this.touch(parent);
      return;
    }

    const found = this.findBlockedDescendant(parent, []);
    parent.session.needsAttention =
      found === null
        ? null
        : {
            reason: found.attention.reason,
            since: found.attention.since,
            // The breadcrumb travels with it, because "something below this
            // needs you" is not actionable — you have to be able to get there.
            from: { sessionId: found.sessionId, title: found.title, path: found.path },
          };
    this.touch(parent);
  }

  /** Depth-first, nearest first: the closest blockage is the one to name. */
  private findBlockedDescendant(
    live: LiveSession,
    path: string[],
  ): { sessionId: SessionId; title: string; path: string[]; attention: NonNullable<Session['needsAttention']> } | null {
    for (const ref of live.session.children) {
      const child = this.sessions.get(ref.sessionId as SessionId);
      if (child === undefined) continue;
      const here = [...path, child.session.title];

      const attention = child.session.needsAttention;
      /**
       * `needs_input` does not travel.
       *
       * Every turn ends there, so a tree of any size would permanently show a
       * summons from some child or other — and a rail that is always lit is a
       * rail nobody reads, which is the one failure mode that matters for a
       * warning. The same reason it is silent in the notifier and absent from
       * the inbox. It stays on the child's own card, where it is true and where
       * looking at it is a choice.
       */
      if (attention !== null && attention.reason !== 'needs_input') {
        // A blockage already bubbled from further down keeps its own origin,
        // rather than being re-attributed to the child that relayed it.
        return attention.from !== undefined
          ? { sessionId: attention.from.sessionId, title: attention.from.title, path: [...here, ...attention.from.path], attention }
          : { sessionId: child.session.sessionId, title: child.session.title, path: here, attention };
      }

      const deeper = this.findBlockedDescendant(child, here);
      if (deeper !== null) return deeper;
    }
    return null;
  }

  /**
   * Cancel a session, turning its children into roots (§4.3).
   *
   * > Cancelling a parent orphans its children into roots rather than destroying
   * > them.
   *
   * Each child is self-contained and independently valuable — its own log, its
   * own workspace, its own budget — so adopting it as a root is the safe default
   * and cascading cancellation is the thing that needs asking about. A child
   * destroyed with its parent takes a transcript worth reading with it.
   */
  async cancelSession(sessionId: SessionId, actor?: Actor): Promise<void> {
    const live = this.live(sessionId);

    for (const ref of live.session.children) {
      const child = this.sessions.get(ref.sessionId as SessionId);
      if (child === undefined) continue;

      child.session.tree = {
        rootSessionId: child.session.sessionId,
        depth: 0,
        ancestry: [],
      };
      await child.store.append(
        { type: 'session.orphaned', formerParentSessionId: sessionId },
        { ...(actor !== undefined ? { actor } : {}) },
      );
      this.emit('session', child.session);
    }

    live.session.children = [];
    await this.setState(live, 'failed', 'cancelled by the user');
  }

/**
   * What this session is blocked on itself, ignoring anything beneath it.
   *
   * A pending split outranks the state-derived answer, because it *is* the
   * blockage: the session sits in an ordinary state between turns while the
   * question it asked goes unanswered, and an attention computed from state
   * alone would forget it the moment anything else happened.
   */
  private ownAttention(live: LiveSession): Session['needsAttention'] {
    if (live.pendingSplits.size > 0) {
      return { reason: 'split_proposed', since: live.session.needsAttention?.since ?? this.now().toISOString() };
    }
    return attentionFor(live.session.state, live.session.needsAttention?.since ?? this.now().toISOString());
  }

  /**
   * An agent asks to split; a person decides (§4.3).
   *
   * > Automatic splitting is policy-gated and off by default: it multiplies
   * > cost, and a decomposition mistake made autonomously produces a tree of
   * > subtly mis-scoped children that is harder to salvage than a single
   * > overlong session.
   *
   * So this only ever *records* and *asks*. Nothing here creates a session —
   * that is `spawnChild`, and it runs when somebody says yes.
   *
   * Logged when proposed rather than when approved, so the transcript shows
   * what was suggested and declined as well as what happened. A record of only
   * the approved splits hides every decomposition the user thought was wrong,
   * which is the more interesting half when a session goes badly.
   */
  async proposeSplit(
    sessionId: SessionId,
    proposal: Omit<SplitProposal, 'proposalId'>,
    agentId?: AgentId,
  ): Promise<SplitProposal> {
    const live = this.live(sessionId);
    const full: SplitProposal = { ...proposal, proposalId: uuidv7() };

    live.pendingSplits.set(full.proposalId, full);
    live.session.pendingSplits = [...live.pendingSplits.values()];
    await live.store.append(
      { type: 'session.split_proposed', proposal: full },
      { ...(agentId !== undefined ? { agentId } : {}) },
    );

    /**
     * Spend a grant if there is one (§17 Q8).
     *
     * The proposal is written **first**, unconditionally, so an automatic split
     * leaves exactly the transcript a manual one does — proposed, then decided.
     * A path that skipped straight to spawning would produce a child with no
     * record of what was suggested, which is the half §4.3 says is the more
     * interesting one when a session goes badly.
     *
     * What is skipped is `needsAttention`. That is the stall being removed, and
     * it is the only thing being removed.
     */
    if (this.mayAutoSplit(live)) {
      // Through the ordinary decision path, so approval means the same thing
      // however it was reached — including `spawnChild` refusing on a limit or a
      // bad brief, which must still be able to refuse.
      await this.respondSplit(sessionId, full.proposalId, { approved: true }, AUTO_ACTOR);
      // Spent **after** the child exists, not before. Decrementing first charges
      // the grant for a split that did not happen: `respondSplit` throws when
      // the spawn is refused, and a run would then lose an allowance to a
      // malformed proposal it never got a child out of.
      const grant = live.session.splitGrant;
      if (grant !== undefined) {
        live.session.splitGrant = { ...grant, remaining: grant.remaining - 1 };
        this.touch(live);
      }
      return full;
    }

    live.session.needsAttention = this.ownAttention(live);
    this.touch(live);
    // Up to the root, like any other blockage: a proposal three levels down is
    // as easy to lose as a permission prompt.
    this.rollUp(live);
    return full;
  }

  /**
   * Whether this proposal may be approved without asking.
   *
   * Depth is checked here and not only in `spawnChild`, because the two answer
   * different questions. §4.3's `maxDepth` is the hard ceiling for any split at
   * all; the grant's is how deep a *person was willing to be absent for*, which
   * is normally shallower. Reaching it means the next split asks, which is the
   * grant working rather than failing.
   */
  private mayAutoSplit(live: LiveSession): boolean {
    const grant = live.session.splitGrant;
    if (grant === undefined || grant.remaining <= 0) return false;
    return live.session.tree.depth + 1 <= grant.maxDepth;
  }

  /** Answer a proposal. Approval spawns; refusal is recorded and is not a failure. */
  async respondSplit(
    sessionId: SessionId,
    proposalId: string,
    decision: { approved: boolean; reason?: string },
    actor?: Actor,
  ): Promise<Session | null> {
    const proposal = this.live(sessionId).pendingSplits.get(proposalId);
    if (proposal === undefined) throw new Error(`no pending split ${proposalId}`);
    if (!(await this.settleSplit(sessionId, proposalId, decision, actor))) return null;

    return this.spawnChild(sessionId, spawnInputFor(proposal), actor);
  }

  /**
   * Record that a proposal was answered, whichever way (§4.3).
   *
   * Shared by both entry points so the parent's history reads the same however
   * the child was created. Cleared *before* any spawn is attempted: a spawn can
   * refuse on a limit, and a proposal left pending after it was answered would
   * ask the same question forever.
   *
   * Returns whether the caller should go on to make a child.
   */
  private async settleSplit(
    sessionId: SessionId,
    proposalId: string,
    decision: { approved: boolean; reason?: string },
    actor?: Actor,
  ): Promise<boolean> {
    const live = this.live(sessionId);
    live.pendingSplits.delete(proposalId);
    live.session.pendingSplits = [...live.pendingSplits.values()];
    await live.store.append(
      {
        type: 'session.split_decided',
        proposalId,
        approved: decision.approved,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      },
      { ...(actor !== undefined ? { actor } : {}) },
    );

    live.session.needsAttention = this.ownAttention(live);
    this.touch(live);
    this.rollUp(live);
    return decision.approved;
  }

  /**
   * Answer a split and work out the child, without creating it (§17 Q5).
   *
   * `respondSplit` with the creation left out, for the case where the child
   * belongs on another machine. Everything that changes the *parent* — clearing
   * the proposal, recording the decision — happens here, because that is the
   * parent's own history and it is settled either way. Everything that changes
   * the parent's *budget* does not, because the child does not exist yet.
   */
  async prepareSplit(
    sessionId: SessionId,
    proposalId: string,
    decision: { approved: boolean; reason?: string },
    actor?: Actor,
  ): Promise<{ create: CreateSessionInput; parentBudget: SessionBudget; contract: ResultContract } | null> {
    const proposal = this.live(sessionId).pendingSplits.get(proposalId);
    if (proposal === undefined) throw new Error(`no pending split ${proposalId}`);

    const settled = await this.settleSplit(sessionId, proposalId, decision, actor);
    if (!settled) return null;

    const prepared = await this.prepareChild(sessionId, spawnInputFor(proposal));
    return { ...prepared, contract: proposal.contract };
  }

  /**
   * A child hands its result up, within the ceiling it agreed to (§4.3).
   *
   * > The failure mode to prevent: a child returns its transcript, the parent's
   * > context explodes, and you have reproduced the original problem one level
   * > up.
   *
   * An over-ceiling summary is **not** refused, and that is deliberate:
   * `checkResult` returns a verdict rather than throwing so an oversized answer
   * becomes an artifact plus a pointer instead of a failed child. Work that was
   * done well and described at length should not be thrown away for the length.
   * What the child does not get is a larger injection.
   *
   * The result lands on the **parent's** log, because that is who it is for. The
   * child's own transcript already holds the detail, and a person may drill into
   * it — but that is a human reading, not context entering a model.
   */
  async reportResult(
    sessionId: SessionId,
    result: { summary: string; artifactIds?: string[] },
    agentId?: AgentId,
  ): Promise<{ summary: string; truncated: boolean }> {
    const live = this.live(sessionId);
    const parentId = live.session.tree.parentSessionId;
    if (parentId === undefined) throw new Error('this session has no parent to report to');

    const contract = live.contract ?? { summaryMaxTokens: 1_000, artifacts: [] };
    const artifactIds = result.artifactIds ?? [];
    const verdict = checkResult(
      contract,
      result.summary,
      live.session.artifacts.map((a) => ({ kind: a.kind })),
    );

    let summary = result.summary;
    let truncated = false;
    if (verdict.estimatedTokens > contract.summaryMaxTokens) {
      // Written where it can be read in full, and referenced by a line that
      // fits. The child does not get to negotiate a larger injection.
      const stored = await live.store.attach(Buffer.from(result.summary, 'utf8'), 'text/markdown');
      await live.store.append({ type: 'artifact.created', artifactId: stored.sha256, kind: 'result-summary' });
      artifactIds.push(stored.sha256);
      summary =
        `${result.summary.slice(0, 400)}… [full result stored as artifact ${stored.sha256.slice(0, 12)}; ` +
        `${verdict.estimatedTokens} tokens exceeds the agreed ceiling of ${contract.summaryMaxTokens}]`;
      truncated = true;
    }

    const parent = this.sessions.get(parentId as SessionId);
    if (parent !== undefined) {
      await parent.store.append({
        type: 'session.child_result',
        childSessionId: sessionId,
        summary,
        artifactIds,
      });
      this.emit('session', parent.session);
    }

    await this.setState(live, 'done', 'reported its result to its parent');
    void agentId;
    return { summary, truncated };
  }

  /** Current derived state, folded from the log (§5.1). */
  async projection(sessionId: SessionId) {
    return (await this.live(sessionId).store.load()).projection;
  }

  /**
   * Everything here worth having told someone about (§11).
   *
   * Folded from the logs rather than accumulated in memory, so it reads the same
   * after a restart, after a crash, and for a client that was not attached when
   * any of it happened — which is most of the point, since a detached host keeps
   * working while the app is closed.
   *
   * Only the tail of each log is read. An inbox is a list you look at, not an
   * archive, and folding a month of transcript to show twenty lines would make
   * opening it cost more the longer a workspace had been used.
   */
  async inbox(limit = 50): Promise<InboxEntry[]> {
    /*
     * One marker per workspace, not one per host (§5.1).
     *
     * The marker lives inside the workspace, so it moves with the folder along
     * with the sessions it describes — which is the requirement a host serving
     * several folders must not quietly break. A host-wide marker would live
     * where the host is, and dragging a project to another machine would arrive
     * with every finished session unread again.
     */
    const markers = new Map<InstanceId, number>(
      await Promise.all(
        this.listWorkspaces().map(
          async (ws): Promise<[InstanceId, number]> => [
            ws.instanceId,
            await this.readMarker(ws.root).read(),
          ],
        ),
      ),
    );
    const parts = await Promise.all(
      [...this.sessions.values()].map(async (live) => {
        const from = Math.max(0, live.store.nextSeq - INBOX_EVENT_WINDOW);
        return entriesFrom(
          live.session,
          await live.store.readEvents(from),
          // Zero for a workspace with no marker, which is `ReadMarker.read`'s
          // own answer for one that was never read: everything unread, which is
          // the direction that shows you something twice rather than hiding it.
          markers.get(live.session.instanceId) ?? 0,
        );
      }),
    );
    return merge(parts, limit);
  }

  /**
   * Mark everything up to now as seen.
   *
   * Per workspace, not per client: two devices attached to one host should agree
   * about what has already been looked at, for the same reason the host owns
   * session state at all (§8).
   */
  async markInboxRead(at: Date = this.now()): Promise<void> {
    // Every workspace this host holds, because the inbox the person just looked
    // at spanned all of them. Marking only one would leave rows they have seen
    // coming back unread, which is the failure that makes an inbox stop being
    // read at all.
    await Promise.all(this.listWorkspaces().map((ws) => this.readMarker(ws.root).mark(at)));
  }

  private readMarker(root: string): ReadMarker {
    return ReadMarker.in(workspaceLayout(root).dir);
  }

  /**
   * Session ids present on disk, whether or not they are loaded (§5.1).
   *
   * Across every workspace this host holds, each row saying which one it came
   * from. `instanceId` and not a path: the row is an answer about a *checkout*
   * (§5.2), and a caller that wanted to open it would look it up rather than
   * join a string.
   */
  async listOnDisk(): Promise<
    Array<{
      sessionId: SessionId;
      title: string;
      goal: string;
      instanceId: InstanceId;
      group?: { groupId: string; name: string };
    }>
  > {
    const found: Array<{
      sessionId: SessionId;
      title: string;
      goal: string;
      instanceId: InstanceId;
      group?: { groupId: string; name: string };
    }> = [];
    for (const workspace of this.listWorkspaces()) {
      const dir = workspaceLayout(workspace.root).sessionsDir;
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // no sessions yet is not an error
      }
      for (const name of names) {
        try {
          const meta = JSON.parse(
            await readFile(join(dir, name, 'session.json'), 'utf8'),
          ) as SessionMeta;
          found.push({
            sessionId: meta.sessionId,
            title: meta.title,
            goal: meta.goal,
            instanceId: workspace.instanceId,
            // Only where the file says so. Absent is *this file does not say* —
            // a session written before the hint existed, or one whose group was
            // changed by another client — and a reader must not round that to
            // "no group" (§17 Q22).
            ...(meta.group !== undefined ? { group: meta.group } : {}),
          });
        } catch {
          // A directory without readable metadata is not a session. Skipping it
          // is right: this list drives a picker, and one bad entry must not hide
          // every good one.
        }
      }
    }
    return found;
  }

  /**
   * Which open workspace holds a session's log (§5.1).
   *
   * Named when the caller knows — the fleet does, from the row it clicked — and
   * looked for on disk when it does not, which is the CLI's case and the case a
   * `sessionId` typed at a terminal has to work in. Looked for by reading the
   * session's own `session.json`, never by trusting a path: the only thing that
   * makes a session belong to a folder is its log being in it.
   *
   * Refused **naming every workspace searched**, because "no such session" on a
   * host holding four folders is a sentence a person cannot act on.
   */
  private async workspaceHolding(
    sessionId: SessionId,
    instanceId?: InstanceId,
  ): Promise<ManagedWorkspace> {
    if (instanceId !== undefined) return this.workspaceOf({ instanceId, sessionId });
    const held = this.listWorkspaces();
    for (const workspace of held) {
      try {
        await readFile(sessionLayout(workspace.root, sessionId).sessionFile, 'utf8');
        return workspace;
      } catch {
        // Not in this one. The next workspace, or the refusal below.
      }
    }
    throw new Error(
      `no session ${sessionId} on this host — looked in ${held.map((w) => w.root).join(', ')}`,
    );
  }

  /**
   * Reattach to a session that exists on disk — the restart path (§15 Phase 1).
   *
   * Everything comes from the log: state, agents, usage, checklist, artifacts.
   * No handle is opened and no runtime is contacted until a turn is sent, so
   * reopening the app is cheap no matter how many sessions exist, and a session
   * whose provider is currently unreachable still loads and displays.
   *
   * Capabilities are **re-admitted rather than replayed** from `agent.created`.
   * The recorded set is provenance — what it ran under last time — and §3.2 says
   * capabilities belong to adapter + model + installed tool version, any of
   * which can change while the app is closed. Trusting the recording would let
   * an agent resume claiming a capability its upgraded runtime no longer has.
   */
  async resumeSession(sessionId: SessionId, instanceId?: InstanceId): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.session; // idempotent

    const workspace = await this.workspaceHolding(sessionId, instanceId);
    const { store, truncatedBytes } = await SessionStore.open(workspace.root, sessionId);
    const meta = await store.readMeta();
    const { projection } = await store.load();

    store.onAppend = (event) => {
      this.spoke(sessionId);
      this.emit('event', sessionId, event);
    };

    const target: ExecutionTarget = { kind: 'local' };
    /*
     * Restored from the log, not re-granted: the person said yes once, for
     * this session, and a restart is still this session (§17 Q19). Dropping
     * it here would silently re-arm the gate mid-run — the overnight stall
     * the grant exists to remove, brought back by a host restart.
     *
     * Restored as a *pair*. The session's effective policy is not otherwise
     * durable — the line below rebuilds it from the target's defaults — and
     * before the grant existed that loss was fail-closed: a `deny` the person
     * had configured degraded to `ask`, and a person got asked. A restored
     * grant answers asks unattended, so restoring it alone would convert
     * every lost refusal into a silent yes. The grant event carries the
     * policy it was granted beside for exactly this line; `!= null` rather
     * than `!== null` because a projection from an older host arrives with
     * the field absent, and absent must read as "no grant", never "one".
     */
    const grant = projection.standingGrant;
    const session: Session = {
      sessionId,
      instanceId: workspace.instanceId,
      target,
      title: meta.title,
      goal: meta.goal,
      state: projection.state,
      agents: [],
      createdAt: meta.createdAt,
      updatedAt: projection.lastActivityAt ?? meta.createdAt,
      checklist: projection.checklist,
      artifacts: projection.artifacts,
      needsAttention: projection.needsAttention,
      ...(grant != null
        ? {
            standingGrant: {
              grantedAt: grant.grantedAt,
              ...(grant.grantedBy !== undefined ? { grantedBy: grant.grantedBy } : {}),
            },
          }
        : {}),
      ...(projection.skills.length > 0
        ? { skills: projection.skills.map((s) => ({ id: s.id, description: s.description })) }
        : {}),
      tree: { rootSessionId: sessionId, depth: 0, ancestry: [] },
      children: projection.children,
      // Restored from the log, like the standing grant and the skills above: a
      // restart is still the same session, and one that had forgotten its group
      // would show peer messages in its own transcript with nobody to answer,
      // then refuse a reply to the sibling that had just asked (§17 Q22).
      ...(projection.group != null ? { group: { ...projection.group } } : {}),
      pendingSplits: [],
    };

    const live: LiveSession = {
      session,
      store,
      lastEventAt: this.now().getTime(),
      waitingOnQuota: new Set<AgentId>(),
      hops: new Map<AgentId, number>(),
      worktrees: new Map<AgentId, Worktree>(),
      pendingSplits: new Map<string, SplitProposal>(),
      // The pair, or the defaults: a granted session resumes under the rules
      // the gate was relaxed beside. Cloned so the projection — which may be
      // a checkpoint another fold continues from — is never handed out as a
      // live, mutable object.
      policy: grant != null ? clonePolicy(grant.policy) : defaultPolicyForTarget(target.kind),
      handles: new Map(),
      specs: new Map(),
      aborts: new Map(),
      /*
       * Filled below from what those seats really printed (§3.12).
       *
       * This used to be empty on the rule that inventing terminal output from
       * the log would put bytes on screen that nothing ever printed there — a
       * good rule, and still kept: nothing here is re-rendered from the
       * transcript. What is restored is the mirror of the ring itself, written
       * beside the log by the run that filled it, so the pane shows the same
       * bytes it was showing before the restart instead of going blank while
       * the chat beside it comes back whole.
       *
       * Populated after `sessions.set`, because reading it is I/O and this
       * object has to exist first.
       */
      rawTails: new Map(),
      // Deliberately empty: an MCP server's env held credentials the log does
      // not carry (§17 Q20), so a restart cannot honestly reconnect. The
      // transcript's `mcp.attached` lines say what used to be here.
      mcp: new Map(),
      // And deliberately full: a skill is pure data the log carries whole
      // (§17 Q21), so a restart is still the session that had it.
      skills: projection.skills.map((s) => ({ ...s })),
    };
    // The rules that let skills load travel with the skills, not with luck:
    // the defaults never had them. Skipped where already present — a granted
    // session's restored policy carries them, since the rules were pushed
    // before the grant event snapshotted it.
    for (const skill of live.skills) {
      const name = `skill__${skill.id}`;
      if (!live.policy.rules.some((r) => r.tool === name && r.action === 'allow')) {
        live.policy.rules.push({ tool: name, action: 'allow' });
      }
    }
    this.sessions.set(sessionId, live);
    await this.restoreRawTails(live);

    for (const projected of projection.agents) {
      const spec: AgentSpec = {
        agentId: projected.agentId,
        role: projected.role as AgentRole,
        runtimeId: projected.runtimeId,
        auth: { kind: 'none' },
        toolPolicy: clonePolicy(live.policy),
        limits: projected.limits ?? {},
        workspacePath: workspace.root,
        ...(projected.model !== undefined ? { model: projected.model } : {}),
        ...(projected.systemPrompt !== undefined ? { systemPrompt: projected.systemPrompt } : {}),
        ...(projected.reasoning !== undefined ? { reasoning: projected.reasoning } : {}),
      };

      /*
       * A seat the log says was replaced comes back retired, and comes back
       * *without being admitted* (§4.2).
       *
       * Not admitted, because admission asks whether something can run and this
       * never will: a retired seat whose runtime has since been uninstalled
       * would otherwise be skipped as unavailable, and skipping it takes the
       * name off every transcript row it wrote. The capabilities in the record
       * are the ones the log recorded at its creation, which is the honest
       * answer to "what was it gated as" anyway (§5.1).
       *
       * No spec and no `live.specs` entry, so nothing can send to it — the same
       * position `retireSeat` leaves it in on the run where it happened, which
       * is the point: a restart must not resurrect a seat as a second agent.
       */
      if (projected.retiredAt !== undefined && projected.capabilities !== undefined) {
        session.agents.push({
          agentId: projected.agentId,
          role: spec.role,
          spec: stripWorkspacePath(spec),
          resolvedCapabilities: projected.capabilities,
          status: 'retired',
          isolation: projected.isolation,
          resumeToken: null,
          lastEventSeq: projection.lastSeq,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
          },
        });
        continue;
      }

      const admission = await this.deps.registry.admit(spec, projected.isolation, {});
      if (!admission.ok) {
        // Refusing the whole session would make one uninstalled runtime hide an
        // entire transcript. The agent is skipped, the session loads, and the
        // reason is emitted so the UI can say which agent is unavailable.
        this.emit('agent-unavailable', sessionId, projected.agentId, admission.failures);
        continue;
      }

      // Not for a retired seat, which reaches this line only from a log with no
      // recorded capabilities: it is rebuilt so its rows keep a name, never so
      // it can take a turn.
      if (projected.retiredAt === undefined) live.specs.set(spec.agentId, spec);
      const projectedUsage = projection.usage;
      session.agents.push({
        agentId: spec.agentId,
        role: spec.role,
        spec: stripWorkspacePath(spec),
        resolvedCapabilities: admission.capabilities,
        // Not `running`: nothing is running yet. A record restored as running
        // would show a spinner for a turn that no longer exists. And not
        // `retired` either — that is the branch above, taken from the log
        // rather than from memory.
        status: projected.retiredAt !== undefined ? 'retired' : 'idle',
        isolation: projected.isolation,
        // The native token is not persisted, so resume takes the durable path
        // (§5.4) — which is the path that must work anyway.
        resumeToken: null,
        lastEventSeq: projection.lastSeq,
        usage: {
          inputTokens: projectedUsage.inputTokens,
          outputTokens: projectedUsage.outputTokens,
          cacheReadTokens: projectedUsage.cacheReadTokens,
          cacheWriteTokens: projectedUsage.cacheWriteTokens,
          cost: projectedUsage.cost,
        },
      });
    }

    // Any request the log still shows as pending was waiting on a promise in a
    // process that is gone. Withdraw them so the reloaded session offers no
    // prompt that would do nothing when answered.
    if (projection.pendingPermissions.length > 0) {
      await this.withdrawStale(live, projection.pendingPermissions);
      // And move it out of `awaiting_permission`. Withdrawing the requests but
      // leaving the state would produce a session that reports `needs_permission`
      // with no prompt to answer — stranded in exactly the way this is meant to
      // prevent, just more quietly. `awaiting_input` is the honest successor: a
      // person decides what happens next, which is the same disposition
      // `end_turn` gets (§3.9).
      await this.setState(live, 'awaiting_input', 'permission request withdrawn on reload');
    }

    if (truncatedBytes > 0) {
      this.emit('log-truncated', sessionId, truncatedBytes);
    }
    if (projection.skippedLines > 0) {
      this.emit('log-corrupt', sessionId, projection.skippedLines);
    }

    this.emit('session', session);
    return session;
  }
}

const ATTENTION: Partial<Record<SessionState, AttentionReason>> = {
  awaiting_input: 'needs_input',
  awaiting_permission: 'needs_permission',
  awaiting_credentials: 'needs_credentials',
  awaiting_quota: 'quota_exhausted',
  failed: 'failed',
};

function attentionFor(state: SessionState, since: string): Session['needsAttention'] {
  const reason = ATTENTION[state];
  if (!reason) return null;
  // Sanity: every attention state must be a pause or a terminal failure.
  if (!isPaused(state) && state !== 'failed') return null;
  return { reason, since };
}

function mergeUsage(a: AgentRecord['usage'], b: AgentRecord['usage']): AgentRecord['usage'] {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    // The one rule for adding costs (§10): not knowing is contagious, because a
    // total that quietly drops an unobservable agent is smaller than the truth.
    cost: addCost(a.cost, b.cost),
  };
}

function stripWorkspacePath(spec: AgentSpec): Omit<AgentSpec, 'workspacePath'> {
  const { workspacePath: _drop, ...rest } = spec;
  return rest;
}

