/**
 * The durable event log (DESIGN.md §5.1).
 *
 * `events.jsonl` is append-only. Every turn, tool call, tool result,
 * permission decision, bus message, capture, child spawn, received brief, and
 * state transition is one JSON line with a monotonic `seq`.
 *
 * Two rules govern every event type added here:
 *
 *  1. Append-only means the schema is forever. Readers of an older version
 *     must be able to skip an unknown `type` safely.
 *  2. Every path is workspace-relative (`EncodedPath`), and every event
 *     records which runtime, provider, model, and adapter version produced
 *     it. With one provider that is a nicety; with many it is the difference
 *     between a reproducible transcript and a mystery.
 */

import type { AgentId, EventId, SessionId, Sha256 } from './ids.js';
import type { ContentBlock, DowngradeNote } from './content.js';
import type { EncodedPath } from './paths.js';
import type { PermissionDecision, PolicyRule, ToolPolicy } from './policy.js';
import type {
  AgentMessage,
  PeerMessage,
  ModelRef,
  ReasoningRequest,
  RuntimeCapabilities,
  StopReason,
} from './runtime.js';
import type { PermissionFidelity } from './policy.js';
import type { Actor, ChildRef, SessionBrief, SessionState, SplitProposal } from './session.js';

/** Provenance stamped on every event that came from a model or adapter. */
export interface EventOrigin {
  runtimeId: string;
  adapterVersion: string;
  model?: ModelRef;
  /** Installed vendor CLI version, when the runtime is a CLI subprocess. */
  cliVersion?: string;
}

/** Common envelope. `seq` — not `at` — orders events (§5.4d). */
export interface EventEnvelope {
  id: EventId;
  seq: number;
  /** ISO 8601 from the writing host's clock. Advisory only. */
  at: string;
  /** Measured offset from the app's clock at connect, for cross-machine reading. */
  clockSkewMs?: number;
  agentId?: AgentId;
  origin?: EventOrigin;
  /**
   * The human who caused this, when one did.
   *
   * Absent means *no person acted* — an agent's own output, a state transition,
   * a withdrawal on restart. It never means "a person we could not identify":
   * a client whose identity cannot be established is refused `read-write`
   * (`IdentitySource`), so it cannot produce an event that needs an actor.
   * Reading absence as "unknown human" would make every line of agent output
   * look like an unattributed action.
   *
   * Not stamped on work an agent does *because* of a turn, only on the turn
   * itself. Marking a tool call with the name of whoever last typed would read
   * as though they ran it, and "who approved this" already has its own event
   * (`permission.decided`). The chain from a tool call back to its turn is in
   * the log either way.
   *
   * Added late to an append-only format, so every reader must handle its
   * absence: sessions recorded before this existed have no actor and never
   * will. That is the honest representation — backfilling a guess would put a
   * name on an action nobody verified.
   */
  actor?: Actor;
}

export type EventBody =
  | { type: 'session.created'; goal: string; title: string }
  /**
   * Renamed by a person.
   *
   * In the log rather than only in `session.json`, for the reason every other
   * fact is: a folder carried to another machine has to arrive with its sessions
   * intact (§5.3), and a title that lived only in a sidecar would be the one
   * thing about a session that a copy could lose. It is also an *edit somebody
   * made*, and the log is where this system records those.
   */
  | { type: 'session.renamed'; title: string }
  | { type: 'session.state'; from: SessionState; to: SessionState; reason?: string }
  | { type: 'user.turn'; content: ContentBlock[] }
  | { type: 'agent.text'; text: string }
  | {
      /**
       * What the model thought before answering (§3.4, §3.9).
       *
       * Its own event rather than `agent.text` with a flag, because the two are
       * read differently: an answer is the record of what was said, and this is
       * evidence about how it was reached — folded away by default, and dropped
       * rather than replayed when a session is seeded into a different runtime.
       *
       * `provider` is stamped so that drop can be decided later without
       * guessing which adapter shaped it.
       */
      type: 'agent.reasoning';
      text: string;
      provider: string;
    }
  | { type: 'agent.tool_use'; toolUseId: string; tool: string; args: unknown }
  | {
      type: 'agent.tool_result';
      toolUseId: string;
      ok: boolean;
      /** Full output goes to a blob; the log keeps a bounded summary. */
      summary: string;
      /**
       * Hashes of the non-text a tool produced (§12.1).
       *
       * This was `resultSha256`, singular, and nothing ever set it — so the
       * screenshot `browser_screenshot` hands back reached the model and left no
       * trace a person could open. Plural because a tool may return several and
       * recording the first would put the model and the reader in front of
       * different evidence, which is the gap this closes rather than moves.
       *
       * Safe to retype rather than migrate: it had no writers, so no log in
       * existence carries the old shape.
       */
      resultBlobs?: Sha256[];
      path?: EncodedPath;
    }
  | { type: 'agent.stopped'; stop: StopReason }
  /**
   * One agent addressing another (§4.2).
   *
   * In the log rather than passed in memory, so agent-to-agent traffic is
   * auditable and replayable — the same reason everything else here is. A roster
   * whose coordination happened off the record would make a transcript that
   * shows the work but not the reasoning that directed it.
   */
  | { type: 'agent.message'; message: AgentMessage }
  /**
   * §13 requires *every* decision be logged, not only the prompted ones. An
   * earlier version returned early for policy `allow` and `deny` without
   * appending, so a transcript could show hundreds of tool calls and no record
   * that the gate was ever consulted.
   */
  /**
   * A request that reached a human, recorded *before* anyone answers it.
   *
   * Logged only when the gate's outcome is `ask`: a policy-settled call goes
   * straight to `permission.decided`, and duplicating it here would double the
   * log for every auto-allowed tool use.
   *
   * Durable because the in-memory version could not survive the thing it needed
   * to. A pending request was a `resolve` closure in a `Map`, so it could not be
   * queried from another client and died with its process — and under a central
   * agent host that keeps running while clients come and go, changing device
   * mid-prompt left the agent blocked on a promise nobody could resolve. With
   * the request in the log, the pending set is *derived*: requested, minus
   * decided, minus withdrawn.
   */
  | {
      type: 'permission.requested';
      requestId: string;
      tool: string;
      args: unknown;
      toolUseId?: string;
    }
  /**
   * A request that can no longer be answered, because the agent that asked is
   * gone — the turn ended, the host restarted, the app was closed.
   *
   * Recorded rather than left dangling so a reloaded session shows no prompt for
   * work nothing is waiting on. Offering one would be worse than showing none:
   * answering it would do nothing, silently.
   */
  | {
      type: 'permission.withdrawn';
      requestId: string;
      reason: string;
    }
  | {
      type: 'permission.decided';
      requestId: string;
      tool: string;
      args: unknown;
      decision: PermissionDecision;
      /**
       * Whether policy decided it outright, a human was asked, or the
       * session's standing grant settled it (§17 Q19).
       *
       * `'standing-grant'` is its own value and must be: recording an ungated
       * call as `'policy'` would make *"the workspace policy allows writes
       * here"* and *"a person said yes to everything up front"* the same
       * sentence in the log, and they are different claims about who is
       * answerable.
       */
      via: 'policy' | 'user' | 'escalation-guard' | 'standing-grant';
      /** The deciding rule and the value its `match` was tested against. */
      rule?: PolicyRule;
      subject?: string | null;
      toolUseId?: string;
    }
  /**
   * The session's gate was relaxed: every `ask` from here on is answered yes
   * without a prompt (§17 Q19).
   *
   * An event rather than a field patched onto the session, because "when was
   * the gate relaxed and by whom" is a fact about the transcript — the calls
   * before this line were gated, the ones after it were not, and the
   * envelope's `at` and `actor` are the answer. Refusals are untouched: a
   * policy `deny` and the escalation guard still decide exactly as before,
   * and every settled call still writes its own `permission.decided`. What
   * the grant removes is the question, not the account of it.
   *
   * `policy` is the policy the grant was granted *beside*, and it travels with
   * the grant for the reason §17 Q18's budget travels with the compaction ask:
   * one opinion rather than two that can drift. The session's effective policy
   * is otherwise not durable — a restart rebuilds it from the target's
   * defaults — and restoring the grant without the policy it was scoped
   * against would restore only the permissive half of the pair: a `deny` the
   * person configured would degrade to `ask` and the grant would answer it
   * yes, unattended. Carried here, the pair survives together or not at all.
   */
  | { type: 'permission.standing_grant'; policy: ToolPolicy }
  /**
   * An MCP server was attached to this session and listed its tools (§17 Q20).
   *
   * The provenance line for every `mcp__…` call that follows: which command,
   * with which argument list, offered which tools. `envKeys` records the
   * *names* of the environment variables handed to the process and never the
   * values — §13's rule that a credential never reaches a file that travels,
   * applied to the one place it would otherwise leak by convenience. This is
   * also why resume does not silently reconnect: the log deliberately does not
   * hold enough to restart a server whose auth lived in `env`.
   */
  | {
      type: 'mcp.attached';
      serverId: string;
      command: string;
      args?: string[];
      envKeys?: string[];
      toolNames: string[];
    }
  /**
   * An MCP server named at creation could not be attached (§17 Q20, §3.5).
   *
   * Recorded rather than thrown: the session still runs with what did attach,
   * and a degradation nobody is told about becomes "the agent just ignores
   * that tool". The failure is in the transcript where the missing tools
   * would have been.
   */
  | { type: 'mcp.failed'; serverId: string; reason: string }
  /**
   * A skill was injected into this session (§17 Q21).
   *
   * Carries the whole body, like `session.brief_received` carries the brief:
   * a skill is pure data with no credential in it, so the log can hold what
   * the model may later read — which is what makes a skill survive a restart
   * when an MCP server deliberately cannot.
   */
  | { type: 'skill.attached'; skillId: string; description: string; instructions: string }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      /** Separate because they are priced separately (§3.6a, §10). */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cost?: number | 'unknown';
    }
  | { type: 'content.downgraded'; note: DowngradeNote }
  | { type: 'capture.attached'; sha256: Sha256; mime: string }
  | { type: 'checklist.updated'; itemId: string; state: string; text?: string }
  /** `createdAt` is the envelope's `at` — never duplicated into the body. */
  | { type: 'artifact.created'; artifactId: string; kind: string; path?: EncodedPath }
  | { type: 'bus.message'; from: AgentId; to: AgentId | 'session'; kind: string; content: ContentBlock[] }
  | { type: 'memory.written'; slug: string; summary: string }
  // hierarchy (§4.3)
  | { type: 'session.spawned_child'; child: ChildRef }
  | { type: 'session.brief_received'; brief: SessionBrief; parentSessionId: SessionId }
  | { type: 'session.child_result'; childSessionId: SessionId; summary: string; artifactIds: string[] }
  /**
   * An agent asked to split, and is waiting for a person (§4.3).
   *
   * Logged when proposed rather than when approved, so a transcript shows what
   * was suggested and declined as well as what happened. A record of only the
   * approved splits would hide every decomposition the user thought was wrong,
   * which is the more interesting half when a session goes badly.
   */
  | { type: 'session.split_proposed'; proposal: SplitProposal }
  | { type: 'session.split_decided'; proposalId: string; approved: boolean; reason?: string }
  | { type: 'session.orphaned'; formerParentSessionId: SessionId }
  // groups (§17 Q22)
  /**
   * This session was put in a group, and may now message its members.
   *
   * One fact, on this session's own log, carrying the whole group rather than a
   * reference to one — there is no membership record anywhere else to resolve a
   * reference against, and a group is a set whose members each hold its name.
   */
  | { type: 'session.joined_group'; groupId: string; name: string }
  | { type: 'session.left_group'; groupId: string }
  /**
   * What this session tried to say to another (§17 Q22).
   *
   * Written **whatever happens next**, including when the message is refused —
   * for depth, for length, for a target on another machine or one that has
   * finished. That is `agent.message`'s rule, and the reason is the same: a log
   * of only the successful coordination answers the wrong question.
   *
   * The sender's log records the *attempt*; the recipient's records the
   * *arrival*. A refused message therefore has an attempt and no arrival, and
   * the two logs read together say exactly what happened — which is the shape
   * §4.3 already chose for the parent/child edge, where each end is written so
   * either can be read alone.
   */
  | {
      type: 'session.peer_message_sent';
      message: PeerMessage;
      delivered: boolean;
      /** Why it was not, in the words the sending model was given. */
      refusedBecause?: string;
    }
  /**
   * What another session said to this one (§17 Q22).
   *
   * On the recipient's log because the turn it wakes is otherwise a turn
   * arriving from nowhere — the failure `session.unparked` exists to prevent,
   * where a transcript shows work nobody asked for. It carries no policy, no
   * grant and no blob: a message conveys words, never authority (§13).
   */
  | { type: 'session.peer_message_received'; message: PeerMessage }
  // adapter/agent lifecycle
  /**
   * Recorded when an agent joins a session, so a reloaded log can resolve an
   * `agentId` to the runtime, model, isolation, and permission fidelity it ran
   * under. Without it "which agent tried that" is unanswerable after a restart
   * even though every decision names an agent (§13).
   */
  | {
      type: 'agent.created';
      role: string;
      runtimeId: string;
      model?: ModelRef;
      isolation: 'shared' | 'worktree';
      permissionFidelity: PermissionFidelity;
      capabilities: RuntimeCapabilities;
      /**
       * Recorded because reattaching after a restart rebuilds the `AgentSpec`
       * from this event. Without them an agent came back with no system prompt
       * and default limits while its transcript looked intact — a silent
       * behavior change, which is worse than a visible failure.
       */
      systemPrompt?: string;
      limits?: { maxTurns?: number; maxToolCalls?: number; tokenCeiling?: number; wallClockMs?: number };
      /**
       * Recorded for exactly the reason above. An agent that came back from a
       * restart thinking at the model's default instead of the effort it was
       * admitted with would look identical in the transcript — the silent
       * behaviour change this event exists to prevent (§3.4).
       */
      reasoning?: ReasoningRequest;
    }
  /**
   * A seat stopped being this session's agent (§4.2).
   *
   * A session holds one agent, so changing the model is *this event and then an
   * `agent.created`* — the old seat retired, the new one admitted, in that
   * order and in one place. Written rather than inferred, for three reasons:
   *
   * - `AgentRecord.status` is live state. A resume rebuilds every seat as
   *   `idle` (see `resumeSession`), so a retirement held only in memory would
   *   last until the next restart and then quietly hand the session two active
   *   agents — the thing admission refuses.
   * - `stopped` already means something else: a turn that ended badly. Reusing
   *   it would make "this seat crashed an hour ago" and "this seat was replaced
   *   on purpose" the same word, and admission has to tell them apart.
   * - *When* is the interesting part. A transcript whose answers change
   *   character halfway down should say that the model changed and at what
   *   point, and §5.1's rule is that the log says who did what — the envelope's
   *   `actor` carries the person who chose.
   *
   * `replacedBy` is set when a new seat took over in the same breath, which is
   * every case the UI can produce today; it is optional because a seat retired
   * with nothing behind it is a session waiting for its next agent, not a
   * malformed record.
   */
  | {
      type: 'agent.retired';
      reason: 'replaced' | 'removed';
      replacedBy?: AgentId;
      /** What the seat was, in words, so the line reads without a lookup. */
      was?: string;
    }
  | {
      /**
       * The effort a seat was moved to after admission (§3.4).
       *
       * Its own event rather than a rewrite of `agent.created`, because the log
       * is append-only and because *when* it changed is the interesting part: a
       * transcript where the answers get longer halfway down should say why.
       */
      type: 'agent.reasoning_changed';
      from?: ReasoningRequest;
      to: ReasoningRequest;
    }
  | {
      type: 'agent.started';
      /** `fresh` only when there is genuinely no prior history to carry. */
      resumeMode: 'fresh' | 'native' | 'rehydrated';
      /** Set on `rehydrated`: how much of the log the seed represents. */
      seededThroughSeq?: number;
    }
  | { type: 'agent.compacted'; beforeTokens: number; afterTokens: number }
  /**
   * A human stopped a turn that was running.
   *
   * Recorded because otherwise the transcript shows a turn that simply ends, and
   * "the model stopped" and "someone stopped it" read identically — which is
   * fine with one user and useless with several. `agent.stopped` cannot carry
   * this: it describes how the *model* finished, and an interrupt is a fact
   * about a person, arriving from outside the loop.
   *
   * The envelope's `actor` says who. `delivered` is false when the runtime could
   * not actually be interrupted (§13's capability model) — the request is still
   * worth recording, because "I pressed stop and it kept going" is exactly the
   * thing a transcript needs to explain rather than hide.
   */
  | { type: 'agent.interrupted'; delivered: boolean; note?: string }
  /**
   * The workspace was opened somewhere other than where it last was (§5.3).
   *
   * Recorded because it explains a change the transcript otherwise cannot: an
   * agent that resumed natively yesterday rehydrates today, and without this the
   * log shows a different `resumeMode` for no visible reason. Identity is never
   * derived from a path — that is what makes a move survivable — so a move
   * leaves no other trace at all.
   *
   * The old path is kept verbatim rather than encoded. `EncodedPath` is
   * workspace-relative and this is precisely a fact about the workspace's own
   * absolute location, which is the one thing that encoding would erase.
   */
  | { type: 'workspace.relocated'; from: string; to: string }
  /**
   * A parked session picked its work back up when its quota window reset.
   *
   * Recorded because the turn that follows is a *repeat* of one already in the
   * transcript, and two identical turns with nothing between them reads as a
   * double-send by the user. This is the line that says the machine did it, and
   * why.
   *
   * Not an `actor` on the repeated turn: the person asked once. Attributing the
   * second send to them would claim they pressed something at 4am.
   */
  | { type: 'session.unparked'; reason: 'quota-window-reset'; parkedFor: string };

export type AgbrteEvent = EventEnvelope & EventBody;

/** Event types this build understands. Unknown types are skipped, not fatal. */
export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.created',
  'session.state',
  'user.turn',
  'agent.text',
  'agent.tool_use',
  'agent.tool_result',
  'agent.stopped',
  'permission.requested',
  'permission.withdrawn',
  'permission.decided',
  'permission.standing_grant',
  'mcp.attached',
  'mcp.failed',
  'skill.attached',
  'usage',
  'content.downgraded',
  'capture.attached',
  'checklist.updated',
  'artifact.created',
  'bus.message',
  'memory.written',
  'session.spawned_child',
  'session.brief_received',
  'session.child_result',
  'session.split_proposed',
  'session.split_decided',
  'session.orphaned',
  'session.joined_group',
  'session.left_group',
  'session.peer_message_sent',
  'session.peer_message_received',
  'agent.created',
  'agent.retired',
  'agent.started',
  'agent.compacted',
  'agent.interrupted',
  'workspace.relocated',
  'session.unparked',
  'agent.message',
]);
