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
  ShellProgram,
} from '../types/index.js';
import type { HostChannel } from './protocol.js';

export type RequestId = string;

/**
 * What came back from `endpoints.add` — deliberately not the endpoint.
 *
 * Shaped like `PublicEndpoint`: it says that a credential is attached and never
 * what it is. `path` is here because the next question a person asks after
 * "did it work" is "where did it go", and the answer is a file they can edit by
 * hand on a machine they own.
 */
export interface EndpointAdded {
  endpointId: string;
  path: string;
  authenticated: boolean;
}

/**
 * One workspace a host holds (§5.1, §5.2).
 *
 * `instanceId` and not the path is what identifies it — the path is the one
 * thing about a workspace that changes underneath you (§5.3) — but the path
 * travels too, because a client has to show a person which folder this is and
 * cannot derive one from an id.
 */
export interface WorkspaceInfo {
  instanceId: InstanceId;
  lineageId: LineageId;
  root: string;
  /**
   * Where this checkout was before it moved (§5.3).
   *
   * Carried to clients because it explains a behaviour change they would
   * otherwise see without a cause: agents that resumed natively yesterday
   * rehydrate today. A move leaves no other trace — identity is deliberately not
   * derived from a path — so if the host does not say so, nothing can.
   */
  movedFrom?: string;
}

/**
 * What a host reports about itself once a client connects.
 *
 * **This describes a machine holding workspaces, and it used to describe a
 * workspace.** That is the shape change v21 exists for. A host is one per
 * machine now (§8): it has one install area, one set of credentials, one lease
 * authority and one socket, and it holds however many folders its sessions
 * named. So the machine-level facts — runtimes, endpoints, bundle, pid — stay
 * at the top level where they always were and are now *true* at that level,
 * while everything that was a fact about one checkout moved into `workspaces`.
 *
 * `workspace` is the one this connection is bound to. A connection names its
 * workspace in `hello` and is bound for its lifetime; binding is not mutable,
 * because a command's meaning would then depend on when it was sent.
 */
export interface HostIdentity {
  /**
   * Which **machine** this host is (§5.2, §8).
   *
   * The primary key of a host now that a host is one per machine. Distinct from
   * any `instanceId`, which is one checkout — they coincided for as long as a
   * host was one per workspace, which is exactly why everything asking "is this
   * the same computer" asked the wrong id and got the wrong answer for two
   * folders on one build box.
   *
   * Minted in `~/.agbrte/machine.json`, never from a hostname. Optional only for
   * the shape's sake: a host speaking v21 always sends one, and a host that does
   * not send one is a host from before v21, which a client has already refused
   * to adopt as a machine host.
   */
  machineId?: string;
  /**
   * Every workspace this host currently holds.
   *
   * The list a client needs to know what is open here without opening anything,
   * and the list that makes a folder picker honest: a host that cannot answer
   * this cannot honour a folder either.
   */
  workspaces: WorkspaceInfo[];
  /**
   * The workspace this connection is bound to, when it named one.
   *
   * Absent for a connection that attached the *machine* and no folder — which
   * is a real and useful state (list what is here, ask about models, retire the
   * host) and not a degraded one. Every workspace-scoped command is refused by
   * name on such a connection rather than silently answered about whichever
   * folder happened to be first.
   */
  workspace?: WorkspaceInfo;
  /**
   * Runtime ids this host will actually admit.
   *
   * Not "ids the agent host registered", which is what it used to be and is one
   * process too far away to be true. The agent host registers loops; the *session*
   * host holds the `RuntimeRegistry` that `admit()` consults, and for a while
   * those two sets differed — the agent host detected an installed CLI and
   * reported it here, the session host's registry never gained it, and every
   * client faithfully offered a runtime the owner would refuse. This field is
   * the owner's answer, so the picker and the gate cannot disagree.
   */
  runtimes: string[];
  /**
   * Runtimes this host looked for and did not find, and why (§3.12).
   *
   * Detection is per machine on purpose — that is the whole reason capabilities
   * are a function rather than a constant (§3.2) — but a failed detection used
   * to be *silent*: a host that could not find `claude` said nothing anywhere,
   * and the runtime was simply absent from every list. Absence reads as a bug in
   * the client, and it cost somebody a long session.
   *
   * One line per manifest, computed once at startup, so this is a handful of
   * short strings on a message that already carries the endpoint list.
   *
   * Absent from a host older than v16, which a client must render as *nothing to
   * say* rather than as *everything was found*. That is the same degradation
   * `bundleVersion` takes at v7 and for the same reason: silence is not a claim.
   */
  runtimeNotes?: Array<{ id: string; label: string; reason: string }>;
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
 * ## v16 adds a field to `welcome`, which is v7's case exactly
 *
 * `HostIdentity.runtimeNotes` says which runtimes this host looked for and did
 * not find. A host older than v16 sends none, and a client reading the absence
 * learns what is true — that this host cannot say — rather than being told
 * everything was found. The screen it degrades to is the one that shipped
 * before v16: the runtime is simply not listed, with no explanation. Worse than
 * the new one, and not wrong.
 *
 * No `COMMAND_SINCE` entry, because no command was added. The bump exists so a
 * client can tell "this host has nothing to report" from "this host predates
 * reporting" — and because §17 Q16's rule is that the number moves whenever the
 * shape does, so that the one case a version check must catch stays legible.
 *
 * ## v15 adds two commands, and one field that needs the v6 argument
 *
 * `session.group` and `session.ungroup` are commands, which is the case this
 * table handles cleanly: a v14 host does not have them, `supports()` says so,
 * and the UI reports that grouping needs a newer host on that machine rather
 * than appearing to work and losing the group at the wire.
 *
 * The field is `Session.group`, which a v14 host never sets. A client reads its
 * absence as *this session is in no group* — which is true of every session a
 * v14 host holds, since nothing there can put one in a group. The degradation
 * is to the old behaviour rather than a wrong one. Worth stating because the
 * opposite direction would not be safe: a field whose absence made a session
 * look *ungrouped while it was messaging* would need `MIN_CLIENT_PROTOCOL`, and
 * the reason this one is fine is a property of the field, not of the mechanism.
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

/**
 * ## v19 adds two commands, which is the case this table handles cleanly
 *
 * `files.list` and `files.read` let a person look at the workspace a session is
 * working on. A v18 host does not have them, `supports()` says so, and the
 * sidebar reports that browsing needs a newer host *on that machine* — one
 * feature, named, rather than a broken connection.
 *
 * Two commands rather than one `files.tree`, and that is the design rather than
 * a decomposition. A recursive listing of a `node_modules` tree over ssh is a
 * request that never comes back with nothing on screen to explain it, so the
 * shape that would allow one is absent: `files.list` answers about **one
 * directory**, and there is no `depth`, no `recursive` and no glob to ask it for
 * more. Expanding a folder is another round trip, which is exactly the cost a
 * person is choosing to pay by clicking it.
 *
 * Both are **reads**, so a `read-only` client may use them — the same call
 * `session.events` and `blob.get` make. What a read-only phone must not get is
 * the terminal beside it, and that distinction is the whole reason the role
 * check is per command rather than per feature area.
 *
 * No field was added to anything, so no per-field argument is needed here.
 *
 * ## v18 adds a field whose absence changes a result, so the client checks
 *
 * `session.addAgent` gained `replacing` — the seat a new one takes over from
 * (§4.2). This is *not* the v6 case. There, a field an old host ignored left the
 * old behaviour, which was harmless; here an old host ignores it and **adds a
 * second agent** to a session the user was changing the model of, producing
 * exactly the roster the rule exists to prevent, and one that cannot then be
 * saved as a template or rendered without ambiguity.
 *
 * `MIN_CLIENT_PROTOCOL` is the wrong lever — that governs which *clients* a host
 * serves, and the mismatch here runs the other way. So the client asks:
 * `SESSION_ADDAGENT_REPLACING_SINCE` is checked in `HostConnection.addAgent`, and
 * a host that predates it is told about rather than sent a field it would drop.
 * The user sees "that machine's host is too old to change a model in place —
 * update it", which is a sentence with an action in it, instead of a session
 * that quietly grew a seat.
 *
 * Nothing else needs the bump: a v17 host still seats a *first* agent from a v18
 * client, because that call carries no `replacing` at all.
 *
 * ## v17 adds an interactive terminal, which is four commands and two pushes
 *
 * `shell.open` / `shell.input` / `shell.resize` / `shell.close` are commands, so
 * `COMMAND_SINCE` covers them cleanly: a v16 host does not have them, the client
 * greys the control and says the host is too old, and every session on that host
 * keeps working exactly as it did.
 *
 * The pushes need the argument the table cannot make. `push.shell` and
 * `push.shellExit` are only ever produced *in response to* `shell.open`, which a
 * host that predates them cannot receive — so there is no version in which one
 * arrives at a client that would not understand it. That is why they are added
 * without a `MIN_CLIENT_PROTOCOL` bump.
 *
 * **The shape is deliberately locality-blind.** Everything on the wire is a
 * `shellId`, bytes, a size, and a program *selector*; nothing names a machine, a
 * pid, a file descriptor or a path, and `cwd` is decided by the host rather than
 * sent by the client. So a host on a build box implements the same four commands
 * against the same PTY supervisor and the client does not change — the v1
 * restriction to local hosts is a *deployment* fact (a remote host is two
 * bundled `.js` files with no `node_modules` beside them, so the native module
 * is not there), not a protocol one. It also means `{kind:'cli'}` resolves
 * against the *build box's* installed CLIs the day that restriction lifts, which
 * is the only answer that could be right.
 *
 * `shell.open`'s `program` was added inside v17 rather than as a v18, because
 * v17 has not shipped: no released host has ever answered a `shell.open` at all,
 * so there is no deployed peer for which the field is a change. It is optional
 * regardless, and absent means the shell. `{kind:'agbrte'}` joined the same
 * union for the same reason, and needs no bump of its own even once v17 ships:
 * a host that does not know the kind refuses it by name through
 * `TerminalPrograms.resolve`'s exhaustive `switch`, which is the honest answer
 * and reaches the client as a sentence rather than as a broken pane.
 *
 * ## v20 adds `endpoints.add`, which is the first command that carries a secret
 *
 * Every other command in this protocol either asks a question or hands the host
 * a piece of work; this one hands it an API key. That makes it the one place the
 * §6.5 boundary is crossed deliberately rather than avoided, and the argument is
 * about *which* channel rather than about whether to send it at all:
 *
 *  - The alternative is `ssh <host> 'cat > endpoints.json'`, which puts the key
 *    in a command line — readable in `ps` by every account on that machine for
 *    the length of the write. That is strictly worse than this.
 *  - The channel is already the one carrying every turn, every permission
 *    decision and every transcript, and reaching it already required either a
 *    `0700` unix socket or a bearer token from a `0600` file (§6.2). A key is
 *    not the most sensitive thing that has ever crossed it.
 *  - For a remote host that channel is `ssh -L` — loopback on both machines with
 *    an encrypted tunnel between, so the key is never on a network in the clear
 *    and never on the remote's disk except in the `0600` file it is destined
 *    for.
 *
 * What that buys, and the reason it is not simply "sending a key is bad": the
 * key becomes a thing the *host* has and the app does not. The app never stores
 * it, never reads it back — the reply is `{endpointId, path, authenticated}` and
 * `models.list` has always stripped credentials — and a second client attached
 * to the same host inherits the endpoint without anyone re-typing anything. The
 * mode this enables is §6.5's **remote-resident credential** row: highest
 * exposure, and the only one in that table where a detached overnight run keeps
 * going with the laptop shut. It is offered as that, in those words.
 *
 * ## v21 moves the host from a workspace to a machine, and that is a shape change
 *
 * Every bump so far has been additive — a command appeared, or a field did — and
 * §17 Q16's whole argument was that additive bumps must never cost a running
 * host. This one is not additive, and the lever it reaches for is the one that
 * paragraph reserved for exactly this and had never been pulled:
 * `MIN_CLIENT_PROTOCOL`.
 *
 * What changed: `HostIdentity` used to *be* a workspace — `instanceId`,
 * `lineageId`, `workspaceRoot` at the top level — and now describes a machine
 * holding `workspaces`, with the connection's own folder in `workspace`. And the
 * socket moved: it was `agbrte-<instanceId>` and is now `agbrte-<machineId>`,
 * with the record at `~/.agbrte/host.json`.
 *
 * **The socket move is why a version check is not optional here.** A v20 client
 * computes a per-workspace socket, finds nothing, and starts its own host
 * against a workspace this one is already serving — two processes appending to
 * one `events.jsonl`, which is the single thing §5.1 does not survive. A version
 * number cannot stop that on its own, so two things do it together: the machine
 * host leaves a **pointer record** in each workspace's `.agbrte/host.json`, so an
 * old client dials the machine socket rather than spawning; and this host then
 * refuses it by name at the handshake, because a v20 client would read a
 * `welcome` with no `workspaceRoot` in it and conclude the host was shutting
 * down. A refusal that names the remedy beats a client that waits ten seconds
 * and reports the wrong fact.
 *
 * **The other direction still works, which is the part §17 Q16 was written
 * about.** A v21 client meeting a v20-or-older host reads the legacy fields and
 * normalises them into the new shape (`HostConnection` does this), so it can
 * talk to it — and in particular `agbrte stop` can still retire it. That matters
 * because the user's existing hosts are per-workspace and the polite way to
 * replace one is to ask it to stop. A `kill` would work and would cost whatever
 * that host was in the middle of.
 */
export const SESSION_PROTOCOL_VERSION = 21;

/**
 * The first protocol whose `session.addAgent` understands `replacing` (§4.2).
 *
 * Its own constant rather than an entry in `COMMAND_SINCE`, because the command
 * is as old as the protocol and it is the *field* that is new — and because the
 * check it drives is a refusal a person reads, not a greyed-out control.
 */
export const SESSION_ADDAGENT_REPLACING_SINCE = 18;

/**
 * The oldest client a host will serve.
 *
 * Raised only when a command's shape *changes* — that is the case a version
 * check has to catch, and until v21 it had not happened. It has now:
 * `HostIdentity` stopped being a workspace and became a machine, so a v20
 * client reading a `welcome` from this host finds no `workspaceRoot` and, in
 * `connectOrSpawn`, treats a perfectly healthy host as one that is shutting
 * down. That is a wrong fact reported after a ten-second wait, which is the
 * failure mode a refusal exists to replace.
 *
 * Raising it costs exactly what §17 Q16 says a bump must never cost — the
 * connection — and it is paid here on purpose, because the alternative is the
 * one thing worse: a client that cannot see this host, starts its own against
 * the same workspace, and puts a second writer on a log.
 */
export const MIN_CLIENT_PROTOCOL = 21;

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
  'session.group': 15,
  'session.ungroup': 15,
  'shell.open': 17,
  'shell.input': 17,
  'shell.resize': 17,
  'shell.close': 17,
  'files.list': 19,
  'files.read': 19,
  'endpoints.add': 20,
  // Below `MIN_CLIENT_PROTOCOL`, so no client that reaches a host can be told
  // "too old" for these. Listed anyway: the table is the record of when a
  // command appeared, and a gap in it is what makes the next raise unreadable.
  'workspace.list': 21,
  'workspace.open': 21,
};

// ------------------------------------------------------------------ app → host

export type SessionCommand =
  /** Always first. Carries the role the client wants. */
  /**
   * Always first. Carries the role the client wants, the protocol it speaks, and
   * the workspace it wants this connection bound to.
   *
   * `protocol` is optional because a host older than this field still has to be
   * able to read a `hello` from a client that sends it — and, symmetrically,
   * absent means "v1 or a client that predates negotiation", which is the safest
   * thing for it to mean.
   *
   * `workspace` is a **path**, not an `instanceId`, and that is the one place in
   * this protocol where a path is the right key. A client is trying to open a
   * folder it has just been handed by a person or a picker; it does not know the
   * checkout's id until the host has read `instance.json` inside it, and the
   * whole point of asking is to find out. The host answers with the id.
   *
   * Absent binds to the host's only workspace when it has exactly one, and
   * binds to nothing when it has several — refusing to guess, because guessing
   * would serve one folder's transcripts to a client that asked about another.
   * A connection that names nothing on a multi-workspace host is not broken: it
   * is a *machine* connection, and every workspace-scoped command on it is
   * refused by name.
   */
  | {
      t: 'hello';
      id: RequestId;
      role: AccessRole;
      client: string;
      protocol?: number;
      workspace?: string;
    }
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
  /**
   * Write a model endpoint into this host's `endpoints.json` (§3.8, §6.5, §13).
   *
   * **The one command that carries a credential**, and the only one whose field
   * must never appear in a log line, an event, an error message or a reply. See
   * the note on `SESSION_PROTOCOL_VERSION` for why this channel and not `ssh`.
   *
   * A write, and gated as one: it changes where this host's turns can be sent
   * and spends somebody's money when they are. A `read-only` client — §7's phone
   * pinned by an access policy — must not be able to point a build box at an
   * endpoint it pays for.
   *
   * The reply is `EndpointAdded`, which is `PublicEndpoint`-shaped: it says
   * *that* a credential is attached and never what it is. Echoing the key back
   * would put it in the app's memory a second time for no purpose, and in
   * whatever the renderer does with a promise result.
   */
  | {
      t: 'endpoints.add';
      id: RequestId;
      endpoint: {
        id: string;
        label?: string;
        provider: string;
        baseUrl: string;
        /** Absent for a server needing none. Never logged, never echoed. */
        apiKey?: string;
      };
    }
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
   * What this machine's host is holding right now (§8).
   *
   * A read, and deliberately available to a `read-only` client: the same
   * reasoning as `files.list` — a client that can already read a transcript
   * naming a folder is not being protected by hiding the folder's name.
   */
  | { t: 'workspace.list'; id: RequestId }
  /**
   * Open a folder on this machine, so its sessions can be worked in (§8).
   *
   * A **write**: it creates `.agbrte/` if the folder has none, which is a change
   * to the user's disk, and a `read-only` client watching from a phone must not
   * be able to make one on a build box. Idempotent by `instanceId` — naming a
   * folder that is already open returns what is already there, because "the
   * sessions that are there are the sessions you get" and a second open would
   * have nothing different to say.
   *
   * The reply is the `WorkspaceInfo`, which is how a client learns the checkout
   * id it will use for everything afterwards.
   */
  | { t: 'workspace.open'; id: RequestId; root: string }
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
   * would receive.
   *
   * `null` means **this seat has never printed a raw line**, and nothing else.
   * It used to also mean "between turns", because the tail was held by the
   * handle and a one-shot CLI's process is the turn — so the answer went back
   * to `null` the instant the turn ended, and the pane a person opened to read
   * what had just happened was always empty. The tail is kept by the session
   * now, which outlives every handle it opens.
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
  /**
   * Put sessions in a group, so they can message each other (§17 Q22).
   *
   * **All of them in one command, not one call per session.** A group is one
   * fact about a set, and a client looping over members would be a client that
   * can stop halfway — leaving sessions in a group whose other half never
   * joined, which is exactly the disagreement a single `groupId` per session
   * exists to prevent. The host resolves every id before it writes anything.
   *
   * `groupId` absent mints a new group; present joins an existing one, which is
   * how a session is added later without the client having to restate the
   * membership it cannot authoritatively know.
   *
   * A write: it changes what a session can reach, and what can reach it.
   */
  | {
      t: 'session.group';
      id: RequestId;
      sessionIds: string[];
      name: string;
      groupId?: string;
    }
  | { t: 'session.ungroup'; id: RequestId; sessionId: string }
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
  /**
   * Open an interactive terminal in this workspace — **the person's, not an
   * agent's**.
   *
   * A write, and gated as one: it runs programs on this machine. That is the
   * same reasoning `preview.start` records, and it is worth restating because
   * the conclusion is the *opposite* of the one §13 would suggest. §13 gates
   * what a **model** asks for; this is a human client with `read-write` typing
   * on a keyboard, and there is no meaningful sense in which they should be
   * asked to approve their own keystrokes. What does apply is the role check: a
   * read-only phone watching a run must not get a shell on the build box.
   *
   * Nothing *this command* does reaches the event log, the turn queue, or the
   * permission gate, so `sessionId` scopes the pane — and, for the one program
   * that is a client of this host rather than a program on the machine, names
   * the session it attaches to. A person then typing a turn into that client
   * produces events the ordinary way, over this same socket, which is the point
   * of it and is not a hole in the sentence above.
   *
   * No `command`, no `args` and no `cwd`. `program` is a **selector over a
   * closed set** and not a name: `{kind:'shell'}` for the machine's own login
   * shell, `{kind:'cli', cliId}` for one of the agent CLIs *this host detected*,
   * which it resolves against its own `CLI_MANIFESTS`, or `{kind:'agbrte'}` for
   * our own CLI, which the host finds beside its own bundle. An id it did not
   * detect is refused by name and carries back the same sentence the picker
   * already shows for that CLI. A `command` parameter instead would turn this
   * into a general "execute this" RPC with a terminal's name on it, and a client
   * could then widen its own reach by asking politely (§7).
   *
   * Absent means `{kind:'shell'}`, which is what every client that predates the
   * field was asking for.
   */
  | {
      t: 'shell.open';
      id: RequestId;
      sessionId: string;
      program?: ShellProgram;
      cols?: number;
      rows?: number;
    }
  /**
   * Keystrokes, exactly as the emulator produced them.
   *
   * A string rather than base64: this is what the user typed, it is already
   * text, and every hop between here and the PTY is UTF-8. Base64 would cost a
   * third more bytes per keypress to encode something that was never binary.
   */
  | { t: 'shell.input'; id: RequestId; shellId: string; data: string }
  | { t: 'shell.resize'; id: RequestId; shellId: string; cols: number; rows: number }
  /** The pane closed. The PTY goes with it — it is a view, not durable work. */
  | { t: 'shell.close'; id: RequestId; shellId: string }
  /**
   * One directory of the workspace, on the machine that owns it (§6.6).
   *
   * A **read**, so any role may ask: a `read-only` client can already read the
   * transcript, which quotes the files by name, and withholding the file list
   * while showing the diff would keep the caption and hide the picture — the
   * argument `blob.get` records.
   *
   * Asked of the host for the reason `preview.ports` is: over ssh, that machine
   * is the only place the files are. It is what makes a local folder and a build
   * box the same feature rather than two.
   *
   * **One directory.** `path` is workspace-relative with POSIX separators, `''`
   * is the root, and there is no `depth`, `recursive` or glob anywhere in this
   * shape. That is the whole design decision: a recursive walk of a
   * `node_modules` tree over a link with 200 ms of latency is a hang with
   * nothing on screen to explain it, and the only reliable way not to ship one
   * is not to have a parameter that asks for it. Expanding a folder is another
   * round trip, which is the cost the person clicking it is choosing to pay.
   *
   * `limit` may lower the host's cap and never raise it. The host caps
   * regardless and reports how many entries it left out, because a listing that
   * silently stops at 500 is a directory that appears to have 500 things in it.
   *
   * Nothing about this reaches the event log, the turn queue, or §13's gate.
   * §13 covers what a *model* asks the app for — an agent reading a file goes
   * through the `read` tool and its policy. This is a person looking.
   */
  | { t: 'files.list'; id: RequestId; path: string; limit?: number }
  /**
   * One file's text, for a preview pane (§6.6).
   *
   * A read, gated as one, and bounded on the host: over a cap it is **refused by
   * name** rather than truncated, and so is anything that is not valid UTF-8
   * text. Truncating instead would put a half-file on screen with no marker, and
   * streaming megabytes into a renderer is the unbounded buffer §7 forbids
   * wearing a file's name.
   *
   * No `offset`, deliberately — see §17 Q7, where the `read` tool's lack of one
   * is load-bearing. A paging parameter here would let a client loop around the
   * cap, which would make the cap a formality.
   */
  | { t: 'files.read'; id: RequestId; path: string }
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
  /**
   * Terminal output, sent **only to the client that opened it**.
   *
   * The one push in this protocol that is not broadcast, and the exception is
   * the point: every other push describes the session, which is shared, while
   * this describes one person's screen. A second device showing somebody else's
   * shell would be a leak wearing a feature's clothes.
   *
   * Already coalesced by the host into roughly one message per frame, so this is
   * not one message per keystroke echo. It carries no `seq`, is never acked, and
   * is never persisted — there is nothing to refetch, because the log is not
   * where it lives and a terminal's history is the scrollback in front of you.
   */
  | { t: 'push.shell'; shellId: string; data: string }
  /** The program ended. Sent to the owner, for the same reason. */
  | { t: 'push.shellExit'; shellId: string; exitCode: number; signal?: number }
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
  /**
   * Which checkout on that machine holds it (§5.2, §8).
   *
   * A host serves several workspaces, so "on this host" no longer answers
   * "where". `instanceId` and not a path, because a path is the one thing about
   * a workspace that changes underneath you (§5.3) and identity deliberately
   * never derives from one.
   *
   * Absent from a host that predates a host serving more than one workspace, and
   * a client must read absence as *this host's only workspace* rather than as
   * unknown — which is what the host it is talking to actually means by it.
   */
  instanceId?: string;
}
