/**
 * The app ↔ host session protocol (DESIGN.md §6.4, §8).
 *
 * A second protocol, deliberately. `protocol.ts` is the *agent* layer — one
 * `AgentRuntime` reached across a boundary — and it stays exactly what it was.
 * This is the *session* layer: the app asking a host that owns sessions to do
 * things with them.
 *
 * They are separate because the boundaries are separate. §8's table has three
 * processes for one workspace, not two:
 *
 *   app                  clients: render, command; owns no session state
 *   host                 sessions, the event log, the permission gate
 *   agent host (forked)  agent loops, tools
 *
 * ## Why the host owns the log
 *
 * "The session keeps running when the app closes" is not achievable by detaching
 * a process alone. If the app still owned the log, a running agent's events would
 * have nowhere to go the moment the app quit — the work would continue and the
 * transcript would not, which is worse than stopping. §8's table already assigns
 * "log writes" to the host for exactly this reason.
 *
 * ## Roles are granted, not claimed
 *
 * A client asks for `read-write` at handshake and the host decides. Enforcement
 * lives with the owner because a read-only client that can still send is not
 * read-only, and a client cannot be trusted to police itself.
 */

import type {
  CreateSessionInput,
  ReasoningRequest,
  ResultContract,
  SessionBudget,
  AccessRole,
  AgentRecord,
  ContentBlock,
  ExecutionTarget,
  InstanceId,
  LineageId,
  AgbrteEvent,
  PermissionDecision,
  PermissionRequest,
  PermissionResolved,
  Session,
  SessionProjection,
} from '../types/index.js';
import type { HostChannel } from './protocol.js';

export type RequestId = string;

/** What a host reports about itself once a client connects. */
export interface HostIdentity {
  instanceId: InstanceId;
  lineageId: LineageId;
  workspaceRoot: string;
  /** Runtime ids the forked agent host actually registered. */
  runtimes: string[];
  /**
   * Models this host can reach, with no credentials attached.
   *
   * One host can reach several — a local server and a hosted API, two GPUs with
   * different weights — so a client offers a choice rather than assuming one.
   * `provider` travels with them because §13 requires that adding a provider
   * never quietly change where source code is transmitted, and a client that
   * cannot name the recipient cannot show it.
   */
  endpoints?: Array<{
    id: string;
    label: string;
    provider: string;
    baseUrl: string;
    authenticated: boolean;
  }>;
  /** Set when the agent host could not start. Sessions still load read-only. */
  unavailableReason?: string;
  /**
   * Where this workspace was before it moved (§5.3).
   *
   * Carried to clients because it explains a behaviour change they would
   * otherwise see without a cause: agents that resumed natively yesterday
   * rehydrate today. A move leaves no other trace — identity is deliberately not
   * derived from a path — so if the host does not say so, nothing can.
   */
  movedFrom?: string;
  /**
   * The bundle this host is executing (§6.3).
   *
   * Absent when the file carries no stamp — a development run from source, or a
   * host deployed before v7. Absent rather than guessed, because the remedy a
   * client offers on a mismatch is *restart this host*, and offering that
   * against a wrong number costs somebody their running turn.
   *
   * A host keeps executing the bundle it started with, so a client that has
   * deployed a newer one cannot tell from the filesystem whether it took effect.
   * Only the host knows, and now it says.
   */
  bundleVersion?: string;
  /** The host's own pid, so a client can report which process it is talking to. */
  pid: number;
  /** Protocol version, so a client knows which commands this host has. */
  protocol: number;
  /**
   * The oldest client this host will serve.
   *
   * Optional because hosts deployed before negotiation do not send it, and their
   * silence means 1 — which is true of them.
   */
  minProtocol?: number;
}

/**
 * Bumped whenever a command is added or its shape changes.
 *
 * A detached host outlives the app that spawned it, so a *newer* app can meet an
 * *older* host — the one direction a single-process design never has to
 * consider.
 *
 * ## It used to be compared for equality, and that disarmed the upgrade
 *
 * The rule was "any mismatch is refused at handshake", which is right when a
 * field moves and much too strong when a command is merely added. §6.7 added two
 * commands and moved nothing; every running host was refused until restarted.
 *
 * Worse, and found on a real server rather than reasoned about: `agbrte stop`
 * speaks the *new* protocol, so the polite shutdown could not reach the old host
 * it existed to retire. **The tool that asks is the tool that was just
 * upgraded.** A bump cost a `kill`, and §8's graceful path was unavailable at
 * exactly the moment an upgrade needed it.
 *
 * ## So compatibility is a range, and each side owns one end
 *
 * The **host** decides whether it will serve a client, because the host is the
 * owner — the same reason roles are granted rather than claimed. It refuses a
 * client older than `MIN_CLIENT_PROTOCOL`, which is the only case where a
 * changed command shape could bite.
 *
 * The **client** decides whether a command is available, from the version the
 * host already reports in `welcome` and the table below. An older host is not a
 * broken connection; it is a connection that cannot do one thing, and it says
 * which.
 *
 * The pleasing part is that this needs nothing from the old host. A v1 host
 * ignores the extra `hello` field and reports `protocol: 1` exactly as it always
 * did, so a client shipping this can talk to hosts that were deployed before it
 * existed.
 *
 * ## v6 adds a *field*, which the table below cannot express
 *
 * `template.save` gained an optional `target`. `COMMAND_SINCE` answers per
 * command, so a v6 client asking a v5 host still gets `true` for
 * `template.save`, sends the field, and the host ignores it — the template is
 * written without a target and applies anywhere, which is precisely what it did
 * before v6. The degradation is to the old behaviour rather than to a broken
 * one, and nothing strands.
 *
 * Written down rather than smoothed over, because it is a real blind spot and
 * the reason this instance is safe is a property of *this* field rather than of
 * the mechanism. A field whose absence changed a result — rather than dropping a
 * restriction that did not exist before — would need `MIN_CLIENT_PROTOCOL`,
 * which is the lever that does exist for shape changes.
 *
 * ## v14 adds a command, and a field to `models.list` — one of each case
 *
 * `models.capabilities` is a command, which is the case this table handles
 * cleanly: a v13 host does not have it, `supports()` says so, and the picker
 * shows *unknown* for the model somebody selected rather than an answer it
 * invented or an error it cannot explain.
 *
 * The field needs the per-field argument v6 established. `models.list` gained
 * `capabilities` — what each listed model says about itself. A v13 host omits
 * it, and the client reads the absence as **nobody could tell**, which is
 * exactly today's behaviour: no badges, and the same list of names that shipped
 * before this existed. The degradation is to the old screen rather than to a
 * wrong one, and — the property that actually matters here — an absent claim is
 * never rendered as `false`. A field whose silent drop would have made a model
 * look incapable rather than unknown would need `MIN_CLIENT_PROTOCOL`.
 *
 * ## v9 adds installing, and one field to an existing reply
 *
 * `models.install` and `models.progress` are commands, so `COMMAND_SINCE`
 * covers them and an older host reports that it cannot rather than failing
 * oddly. `models.list` also gained `runner` / `canInstall` / `installHint`,
 * which a v8 host omits — read as *cannot tell*, which is why the client shows
 * no install control there rather than one that would fail.
 *
 * ## v8 adds a command, which is the case this table was built for
 *
 * `models.list` asks a host what its endpoints currently serve. A host older
 * than v8 does not have it, `supports()` says so, and the client shows the
 * plain text field it always had rather than an empty list that looks like an
 * answer. This is the shape the mechanism handles cleanly — unlike v6 and v7,
 * which added *fields* and needed a paragraph each.
 *
 * ## v7 adds a field to `welcome`, and the same reasoning holds
 *
 * `HostIdentity.bundleVersion` says which bundle a host is running. A host older
 * than v7 sends none, and a client reading its absence learns exactly what is
 * true — that it cannot tell — rather than being told a wrong number. The
 * remedy offered on a mismatch is "restart this host", so a confident guess
 * here would cost somebody their running turn, and silence is the safe value.
 */
/**
 * What a parent's host decided a child should be, before anything created it.
 *
 * Named rather than inlined because three places have to agree on it — the
 * manager that computes it, the wire, and the fleet that hands it to another
 * host — and a shape spelled out three times is a shape that drifts.
 */
export interface PreparedChild {
  create: CreateSessionInput;
  parentBudget: SessionBudget;
  contract: ResultContract;
}

export const SESSION_PROTOCOL_VERSION = 14;

/**
 * The oldest client a host will serve.
 *
 * Raised only when a command's shape *changes* — that is the case a version
 * check has to catch, and the case that has not happened yet.
 */
export const MIN_CLIENT_PROTOCOL = 1;

/**
 * When each command appeared.
 *
 * Absent means "always", which is every command from the first version. A client
 * consults this before using anything optional, so meeting an older host costs
 * one feature rather than the connection.
 */
export const COMMAND_SINCE: Readonly<Record<string, number>> = {
  'blob.has': 2,
  'blob.put': 2,
  'preview.ports': 3,
  // A host deployed at v3 has `preview.ports` and not these. Adding them at
  // v3 would have made `supports` lie to every client that met one.
  'preview.start': 4,
  'preview.stop': 4,
  'preview.servers': 4,
  'preview.log': 4,
  'template.save': 5,
  'template.list': 5,
  'template.apply': 5,
  'template.delete': 5,
  'models.list': 8,
  'session.setReasoning': 10,
  'blob.get': 11,
  'session.prepareSplit': 12,
  'session.recordChild': 12,
  'models.install': 9,
  'models.progress': 9,
  'agent.rawLog': 13,
  'models.capabilities': 14,
};

// ------------------------------------------------------------------ app → host

export type SessionCommand =
  /** Always first. Carries the role the client wants. */
  /**
   * Always first. Carries the role the client wants and the protocol it speaks.
   *
   * `protocol` is optional because a host older than this field still has to be
   * able to read a `hello` from a client that sends it — and, symmetrically,
   * absent means "v1 or a client that predates negotiation", which is the safest
   * thing for it to mean.
   */
  | { t: 'hello'; id: RequestId; role: AccessRole; client: string; protocol?: number }
  /**
   * What is listening on the machine this host runs on (§6.8).
   *
   * Asked of the host because the host is where the answer is: the whole
   * point of the feature is a port on a build box that this machine cannot
   * see. A read, so any role may ask — and it reports only the ports
   * belonging to the user the host runs as, which is a filter about other
   * people's privacy rather than about this client's role.
   */
  /**
   * Session templates (§17 Q12), owned by the host because they live in the
   * workspace beside `memory/` — committed, so a colleague gets them by
   * cloning.
   *
   * `apply` is a host operation rather than a client loop of create-then-add,
   * so the roster that runs is the one in the file the host read. A client
   * assembling it from a template it fetched would be a client that can
   * quietly assemble a different one.
   */
  | {
      t: 'template.save';
      id: RequestId;
      sessionId: string;
      name: string;
      /**
       * How the client reaches this host, when that is worth recording.
       *
       * Sent by the client because the host cannot know it: a host on the
       * build box knows a workspace, not that it is "the build box".
       * Omitted for a local host, and ignored by a host older than v6.
       */
      target?: ExecutionTarget;
    }
  | { t: 'template.list'; id: RequestId }
  | { t: 'template.apply'; id: RequestId; templateId: string; title?: string }
  /**
   * What each endpoint on this host can serve, right now (§3.8).
   *
   * A command rather than a field on `welcome`, because the answer changes while
   * the host runs — `ollama pull` is something a person does *during* a session
   * and expects to see the result of. The handshake reports endpoints, which are
   * configuration; this reports their contents, which are not.
   *
   * A real command, so `COMMAND_SINCE` covers it and an older host says "cannot
   * do that" instead of the client inventing an empty list and showing it as
   * fact.
   */
  | { t: 'models.list'; id: RequestId }
  /**
   * What one model can actually do, established rather than assumed (§3.3, §3.5).
   *
   * A separate command from `models.list` because the costs are not comparable.
   * The list carries what is free — a server's own account of itself, and probes
   * this host has already run — while this one *probes*, which for
   * `openai-compatible` is real inference requests behind a long timeout. §3.13
   * has the precedent: probing every runtime on attach took the end-to-end suite
   * from one minute to nine and was asking about a model nobody had chosen. So
   * this is asked once, for the model in front of somebody.
   *
   * Answering is `ModelCapabilityHint`, whose every claim is optional and
   * labelled with how it was established. A capability that could not be
   * established is absent, and a client must show that as unknown — the reason
   * this command exists is a user who picked a model that could not call tools
   * and was told nothing, and "unknown" rendered as "no" is the same failure
   * with the sign flipped.
   */
  | { t: 'models.capabilities'; id: RequestId; endpointId: string; modelId: string }
  /**
   * Start pulling a model into an endpoint that can accept one (§3.8).
   *
   * Returns as soon as the pull is *started*, not when it finishes: a model is
   * gigabytes, and a request that waits for a 14 GB download is a request that
   * times out somewhere in the four layers between the button and the runner.
   * Progress is asked for separately.
   */
  | { t: 'models.install'; id: RequestId; endpointId: string; tag: string }
  | { t: 'models.progress'; id: RequestId }
  | { t: 'template.delete'; id: RequestId; templateId: string }
  | { t: 'preview.ports'; id: RequestId }
  /**
   * Start a long-lived preview server on the host's machine (§6.8, §3.12).
   *
   * A write, because it runs a command. Deliberately **not** a tool: §3.12's
   * reaping — whatever an agent starts, ends — is a real containment
   * property, and an API that starts a persistent process would launder it if
   * a model could reach it. This is the human client's request, gated on the
   * human client's role.
   */
  | { t: 'preview.start'; id: RequestId; sessionId: string; command: string }
  | { t: 'preview.stop'; id: RequestId; serverId: string }
  | { t: 'preview.servers'; id: RequestId; sessionId?: string }
  | { t: 'preview.log'; id: RequestId; serverId: string }
  | { t: 'session.list'; id: RequestId }
  | { t: 'session.listOnDisk'; id: RequestId }
  /**
   * Search this host's logs (§15 Phase 8).
   *
   * Runs where the logs are, which §6 already requires of remote search: "one
   * `find`-equivalent on the host rather than N round trips". Shipping the logs
   * to the app to grep them would move megabytes over ssh to answer a question
   * about kilobytes.
   */
  | { t: 'session.search'; id: RequestId; query: string; limit?: number }
  | { t: 'session.get'; id: RequestId; sessionId: string }
  /**
   * `input` alongside `title`/`goal`, not replacing them (§17 Q5).
   *
   * The command carried two strings, so every other field a session can be
   * created with — its budget, its policy, and now the position and brief a
   * child inherits — was dropped at the wire and silently defaulted on the far
   * side. That was invisible while only a local manager created children.
   *
   * The old fields stay because `COMMAND_SINCE` cannot express a field
   * addition: a v11 host reads them and ignores what it does not know, which is
   * the same session it would have made before.
   *
   * `input.standingGrant` (§17 Q19) rides in the same envelope and needs the
   * same per-field safety argument written down: a host that predates it drops
   * the field silently, and the session it makes **asks on every gate** — the
   * old behaviour exactly, over-asking rather than over-allowing. The returned
   * `Session` honestly lacks `standingGrant`, so a client that cares can see
   * the grant did not take. A field whose silent drop widened permission
   * instead would need `MIN_CLIENT_PROTOCOL`, which is the lever for shape
   * changes — this one degrades in the only acceptable direction.
   */
  | {
      t: 'session.create';
      id: RequestId;
      title: string;
      goal: string;
      input?: CreateSessionInput;
    }
  | { t: 'session.resume'; id: RequestId; sessionId: string }
  | { t: 'session.addAgent'; id: RequestId; sessionId: string; input: unknown }
  /**
   * A turn from a person.
   *
   * `blocks` alongside `text` rather than replacing it (§12): a screenshot
   * almost always arrives with a sentence attached, and the two together are
   * the message. Every block names a hash this host can already resolve — §6.7
   * put it there before this command was sent — so nothing large travels here.
   */
  | {
      t: 'session.send';
      id: RequestId;
      sessionId: string;
      agentId: string;
      text: string;
      blocks?: ContentBlock[];
    }
  | { t: 'session.interrupt'; id: RequestId; sessionId: string; agentId?: string }
  | {
      t: 'session.setReasoning';
      id: RequestId;
      sessionId: string;
      agentId: string;
      mode: ReasoningRequest['mode'];
    }
  | { t: 'session.events'; id: RequestId; sessionId: string; fromSeq: number }
  | { t: 'session.projection'; id: RequestId; sessionId: string }
  | { t: 'session.queueDepth'; id: RequestId; sessionId: string }
  /**
   * The raw stdout/stderr tail of the CLI subprocess behind one agent (§3.12).
   *
   * A read, so any role may ask: these are the same bytes a client already
   * watches arrive parsed through `session.events`, minus the parsing. Served
   * on request like `preview.log` rather than pushed — a bounded tail polled
   * by the one pane looking at it costs less than a push channel every client
   * would receive. `null` is the ordinary answer between turns: a one-shot
   * CLI's process is the turn (§3.12), and the tail lives and dies with it.
   */
  | { t: 'agent.rawLog'; id: RequestId; sessionId: string; agentId: string }
  /**
   * What one runtime declares it can do, on this host.
   *
   * Asked without a session, because §3.13's matrix is consulted *before*
   * choosing a runtime — and capabilities belong to adapter + model + installed
   * version, so only the machine that has the adapter can answer (§3.2).
   */
  | { t: 'runtime.capabilities'; id: RequestId; runtimeId: string }
  /**
   * The durable record of what happened here (§11).
   *
   * Per host, because it is folded from that host's logs — and a detached host
   * is exactly where the events nobody was told about accumulate.
   */
  | { t: 'inbox.list'; id: RequestId; limit?: number }
  | { t: 'inbox.markRead'; id: RequestId }
  /** Approve or decline a split an agent proposed (§4.3). */
  | {
      t: 'session.respondSplit';
      id: RequestId;
      sessionId: string;
      proposalId: string;
      decision: { approved: boolean; reason?: string };
    }
  /**
   * Does this session already hold these bytes? (§6.7)
   *
   * Asked before every transfer, and answered `true` when a *sibling* session on
   * the same host has them — the host copies locally rather than making a client
   * send a screenshot that machine already received once.
   */
  | { t: 'blob.has'; id: RequestId; sessionId: string; sha256: string; mime: string }
  /**
   * Read stored bytes back, base64'd (§12).
   *
   * `mime` is optional: `agent.tool_result` records a hash and no type, and the
   * store can find `<sha>.*` on its own. The reply is `null` for a blob that is
   * not here — a log outlives the bytes it references, and that is a sentence to
   * show rather than an error to raise.
   */
  | { t: 'blob.get'; id: RequestId; sessionId: string; sha256: string; mime?: string }
  /**
   * Answer a split and work out what the child should be, without creating it
   * (§4.3, §17 Q5).
   *
   * The half of a spawn that belongs to the parent's host. It raises every
   * refusal, reserves against the parent's budget and builds the brief — and
   * changes nothing, so a creation that then fails on the other machine leaves
   * no debit behind. Returns `null` when the split was declined.
   */
  | {
      t: 'session.prepareSplit';
      id: RequestId;
      sessionId: string;
      proposalId: string;
      approved: boolean;
      reason?: string;
    }
  /** Commit a spawn on the parent once the child exists elsewhere (§4.3). */
  | {
      t: 'session.recordChild';
      id: RequestId;
      sessionId: string;
      child: Session;
      parentBudget: SessionBudget;
      contract: ResultContract;
    }
  /**
   * One chunk of a blob, base64 in a JSON message.
   *
   * `offset` rather than a chunk index, so resuming needs no server-side notion
   * of which chunk was which: the client asks how much arrived and continues
   * from the answer. `final` commits — the host assembles, verifies the bytes
   * hash to `sha256`, and only then stores.
   *
   * Every reply carries the byte count received so far, which is both the
   * acknowledgement and the resume point.
   */
  | {
      t: 'blob.put';
      id: RequestId;
      sessionId: string;
      sha256: string;
      mime: string;
      offset: number;
      chunk: string;
      final: boolean;
    }
  | { t: 'permission.pending'; id: RequestId }
  | { t: 'permission.respond'; id: RequestId; requestId: string; decision: PermissionDecision }
  /**
   * Ask the host to exit once nothing is running.
   *
   * Not a kill: a detached host holding a live agent must not be taken down
   * because a window closed. The host decides, and refuses while work is in
   * flight — which is the entire point of it being detached.
   */
  | { t: 'shutdown'; id: RequestId };

// ------------------------------------------------------------------ host → app

export type SessionMessage =
  | { t: 'ok'; id: RequestId; value?: unknown }
  | { t: 'err'; id: RequestId; message: string; name?: string }
  /** Reply to `hello`, and the only place a role is granted. */
  | { t: 'welcome'; id: RequestId; identity: HostIdentity; role: AccessRole }
  // pushes
  | { t: 'push.event'; sessionId: string; event: AgbrteEvent }
  | { t: 'push.session'; session: Session }
  | { t: 'push.permission'; request: PermissionRequest }
  /**
   * A prompt that is no longer open.
   *
   * The other half of `push.permission`. A request reaches every attached
   * client, so an answer has to as well — without this the device that did not
   * answer keeps showing a settled question and only learns otherwise by
   * pressing a button and being told it was too late.
   */
  | { t: 'push.permissionResolved'; resolved: PermissionResolved }
  | { t: 'push.queue'; sessionId: string; agentId: string; depth: number }
  /** The host is going away on purpose, so a client can say so rather than guess. */
  | { t: 'push.closing'; reason: string };

export type AppSideSessionChannel = HostChannel<SessionCommand, SessionMessage>;
export type HostSideSessionChannel = HostChannel<SessionMessage, SessionCommand>;

// --------------------------------------------------------------------- results

/** `session.addAgent` reply. */
export type AddAgentResult = AgentRecord;

/** `session.events` reply. */
export type EventsResult = AgbrteEvent[];

/** `session.projection` reply. */
export type ProjectionResult = SessionProjection;

export interface OnDiskSession {
  sessionId: string;
  title: string;
  goal: string;
}
