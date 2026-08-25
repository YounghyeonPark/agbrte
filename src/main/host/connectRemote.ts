/**
 * Attaching a remote workspace (DESIGN.md §6.2, §6.4).
 *
 * The remote counterpart of `connectOrSpawnHost`, and deliberately the same
 * shape: find the host that is already running, start one if there is none,
 * connect. Everything different is below the `HostConnection`, which is why
 * `Fleet` needs no idea whether a host is on this machine or another one.
 *
 * Ordered so the common case is cheap. Reattaching to a host that is already up
 * — the normal case once you have used a machine once — is one probe, one
 * record read, and a forward. Nothing is uploaded or installed unless it has to
 * be.
 *
 * ## The connection names the folder it wants
 *
 * `hello` carries `workspace`, exactly as `connectOrSpawnHost` does on this
 * machine, and both constructions below pass it. It reads like a detail and it
 * is the whole attach: a host is one per machine and holds several folders
 * (§8), so the folder a connection gets is the one it *asks* for — `bindFor`
 * resolves a held path, opens one that is not held, and binds to **nothing**
 * when a client names nothing and there is more than one to choose from.
 *
 * Omitting it was silent in the only shape a machine has on its first day. One
 * folder open, and `bindFor(undefined)` answers with the host's single
 * workspace — the right folder by luck, for every attach until a second one is
 * opened. From then on the two failures a person actually sees:
 *
 *   * a **new session folder** was created on the remote (`startRemoteHost`
 *     runs `mkdir -p`) and the session landed in whichever folder the host
 *     already had — the sidebar said one thing and the terminal opened another;
 *   * once two folders were held, the connection bound to none, so every
 *     workspace-scoped command — `session.listOnDisk` first — was refused with
 *     "attached to the machine and not to a workspace". A machine row with no
 *     sessions under it, on a machine full of them.
 *
 * Neither is reachable locally, which is why it survived: the local path has
 * passed `workspace` since v21 and every remote test attaches exactly one
 * folder, the case where the omission cannot be seen.
 */

import {
  describeSshFailure,
  freeLoopbackPort,
  installRemoteNode,
  installRemotePty,
  probeRemote,
  readRemoteHostRecord,
  remoteNodeBin,
  RemoteBootstrapFailed,
  startRemoteHost,
  systemSshRunner,
  uploadHostBundle,
  type RemoteProbe,
  type SshRunner,
} from './sshTransport.js';
import {
  installWindowsNode,
  probeWindows,
  readWindowsHostRecord,
  startWindowsHost,
  uploadWindowsBundles,
  windowsNodeExe,
  windowsSshRunner,
} from './windowsBootstrap.js';
import { connect } from '@shared/host/socketChannel.js';
import { connectLoopback } from '@shared/host/loopback.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import { HostConnection } from './hostConnection.js';

export interface RemoteConnectOptions {
  /** An alias from the user's ssh config — `ssh <alias>` must work. */
  alias: string;
  /** Absolute path on the remote. */
  workspaceRoot: string;
  /** The built bundles to deploy: the session host and the agent host it forks. */
  bundles: {
    host: string;
    agent: string;
    /** Agbrte's own CLI, for the terminal pane. Optional: an embedder may have none. */
    cli?: string;
  };
  /** Stamped on the deployed bundle so a later attach knows what is there. */
  bundleVersion: string;
  /**
   * How this client names itself to the host.
   *
   * Settable because the workspace's access policy matches on it: a rule
   * pinning `agbrte-app@phone-*` to read-only can never fire if every client
   * arrives under the same hardcoded name. Defaults to naming the machine
   * being reached, which is what a single-device user sees.
   */
  client?: string;
  runner?: SshRunner;
  lingerMs?: number;
  /** Progress, because a first attach installs a Node runtime and is not instant. */
  onProgress?: (step: string) => void;
}

export interface RemoteConnection {
  connection: HostConnection;
  /** Closes the SSH forward. The remote host keeps running. */
  close(): void;
}

export async function connectRemoteHost(opts: RemoteConnectOptions): Promise<RemoteConnection> {
  const runner = opts.runner ?? systemSshRunner();
  const report = opts.onProgress ?? (() => undefined);

  report('checking the remote');
  const probe = await probeRemote(runner, opts.alias);

  /**
   * A POSIX probe that "succeeded" is not evidence of a POSIX machine.
   *
   * `probeRemote` sends `echo "platform=$(uname -s)"; …` and a Windows remote
   * answers ssh perfectly well, hands it to `cmd.exe`, prints the line back
   * *literally*, and **exits 0**. So the probe reported `reachable: true` with
   * every field empty, and this function went on to install a POSIX Node on a
   * machine that had never run a shell — surfacing as "could not install Node on
   * the remote", which names the wrong problem on the wrong operating system.
   *
   * The condition is `platform`, not `reachable`, because `uname -s` prints
   * something on every POSIX system there is. A probe that cannot say what it is
   * running on did not run as a shell script, whatever the exit code claimed.
   * Checking `reachable` alone was the first version of this and it never fired.
   *
   * The second probe costs a round trip only on a path that was already going to
   * fail; a POSIX remote answers `Linux` or `Darwin` and never reaches it.
   */
  if (!probe.reachable || probe.platform === '') {
    const windows = await probeWindows(windowsSshRunner(), opts.alias);
    if (windows.reachable) {
      return connectWindowsHost(opts, windows, report);
    }

    if (!probe.reachable) {
      // This really is ssh. The *POSIX* detail is reported, not the Windows one:
      // the second probe is a guess this function made, and its error message
      // would describe the guess rather than the user's problem.
      //
      // Classified rather than passed through raw. "Host key verification
      // failed" and "Permission denied (publickey)" are the same sentence to
      // someone who has not met them before, and both read as "this app is
      // broken" — while needing completely different actions.
      throw new RemoteBootstrapFailed(describeSshFailure(opts.alias, probe.detail));
    }

    // Authentication worked and neither shell did, so an ssh diagnostic would
    // send the user to their keys for a problem that is not there.
    throw new RemoteBootstrapFailed(
      `${opts.alias} answered ssh, but its shell is neither a POSIX one nor Windows PowerShell, ` +
        `so there is no way to install a host on it`,
      windows.detail,
    );
  }

  let nodePath = probe.nodePath;
  if (nodePath === null) {
    report('installing a private Node runtime (nothing system-wide)');
    await installRemoteNode(runner, opts.alias, probe);
    nodePath = remoteNodeBin(probe.home);
  }

  if (probe.bundleVersion !== opts.bundleVersion) {
    // Version-stamped rather than always uploaded: the bundle is a few hundred
    // kilobytes, and re-sending it on every attach is a needless round trip on
    // a slow link.
    report('deploying the host');
    await uploadHostBundle(runner, opts.alias, probe.home, opts.bundles, opts.bundleVersion);
  }

  /*
   * The pty module, on every attach and not behind the bundle stamp.
   *
   * It was inside the branch above, which only runs when the deployed bundle is
   * a different version — so a machine that already carried this build never
   * received the module, and the terminal stayed dark on precisely the remotes
   * somebody had attached before. `installRemotePty` asks the far side whether
   * it can load it and returns immediately when it can, so the common case is
   * one `require` over ssh rather than a download.
   *
   * Deployed at attach rather than when a terminal is opened because that is a
   * click, and the wait belongs to the step that was already installing things.
   *
   * Failure is reported and not thrown. A machine with no route to the registry
   * keeps every other thing a host does — the pane says what is missing when
   * somebody reaches for it (§7).
   */
  const pty = await installRemotePty(runner, opts.alias, probe, report);
  if (!pty.installed) {
    report(`no terminal on this machine: ${pty.detail ?? 'the pty module could not be installed'}`);
  }

  // The remote's Node, because the answer is proved by connecting to the socket
  // and a shell cannot do that. See `FIND_HOST_SCRIPT`.
  let record = await readRemoteHostRecord(
    runner,
    opts.alias,
    opts.workspaceRoot,
    probe.home,
    nodePath,
  );

  /**
   * A version difference is **not** a reason to refuse, and this used to think
   * it was.
   *
   * The check here was `record.protocol !== SESSION_PROTOCOL_VERSION`, described
   * as "the same rule the handshake enforces, applied before a forward is set up
   * for nothing". It was not the same rule. The handshake refuses a client older
   * than the host's `MIN_CLIENT_PROTOCOL`; this refused *any* difference, in
   * either direction, before the handshake got to speak — so an additive bump
   * stranded every host already running, telling the user to "stop it there".
   * For a host holding a live agent that means losing the work, and §17.16 exists
   * precisely because a version bump must not require killing the thing it is
   * upgrading.
   *
   * Reproduced against a real remote host running v2 with this app at v3, rather
   * than argued: `REFUSED: the host on build-01 speaks session protocol v2,
   * this app speaks v3`.
   *
   * The client is already equipped for the difference. `HostConnection.supports`
   * consults `COMMAND_SINCE` against the version the host reports in `welcome`,
   * so an older host costs one command rather than the connection — and a host
   * newer than this app decides for itself whether to serve it, which is the
   * host's call for the same reason roles are granted rather than claimed. Both
   * answers arrive from the handshake, which produces a better message than this
   * could: it knows what the host actually said rather than what a file claimed.
   */

  if (record === null) {
    report('starting the host');
    // Returns the record directly: the host is waited for on the remote, inside
    // the same command that starts it. See `startRemoteHost`.
    record = await startRemoteHost(runner, opts.alias, probe.home, nodePath, opts.workspaceRoot, {
      ...(opts.lingerMs !== undefined ? { lingerMs: opts.lingerMs } : {}),
    });
  }

  report('opening the tunnel');
  const port = await freeLoopbackPort();
  const forward = await runner.forward(opts.alias, port, record.socket);

  try {
    // From here down it is the local path exactly: a stream channel carrying the
    // session protocol. Nothing above this line appears in `HostConnection`.
    const channel = await connect<SessionCommand, SessionMessage>({ port }, 10_000);
    const connection = new HostConnection({
      channel,
      client: opts.client ?? `agbrte-app@${opts.alias}`,
      // The folder this connection is asking for. See the header.
      workspace: opts.workspaceRoot,
      onClose: () => forward.close(),
    });
    return { connection, close: () => forward.close() };
  } catch (err) {
    forward.close();
    throw err;
  }
}

/**
 * The same sequence against a Windows remote (DESIGN.md §6.2, §6.3).
 *
 * Deliberately step-for-step with the POSIX path above — probe, install Node if
 * absent, deploy if the version differs, reuse a running host or start one,
 * forward, connect — because the ordering *is* the §6.4 promise that reattaching
 * costs one probe and a forward. Written as its own function rather than as
 * branches inside that one: nearly every call differs (PowerShell instead of
 * `sh`, scp instead of a stream, a loopback port instead of a unix socket), so
 * interleaving them would put an `if` on all six steps and make neither
 * readable.
 *
 * What is genuinely different, and the reason a shared implementation would have
 * been wrong: the control channel. A Windows host cannot listen on a unix
 * socket, so it listens on loopback and proves who it is with a bearer token —
 * §6.1's stated fallback. That token comes back from the host's own record, so
 * it is never stored by this process and never crosses ssh in a command line.
 */
async function connectWindowsHost(
  opts: RemoteConnectOptions,
  probe: RemoteProbe,
  report: (step: string) => void,
): Promise<RemoteConnection> {
  // Not `opts.runner`: a caller who injected one injected a POSIX one, and the
  // whole reason we are here is that the remote is not POSIX. A test that wants
  // to drive this supplies a Windows runner through the same option, which is
  // why the fallback rather than an unconditional override.
  const runner = opts.runner ?? windowsSshRunner();

  let nodePath = probe.nodePath;
  if (nodePath === null) {
    report('installing a private Node runtime (nothing system-wide)');
    await installWindowsNode(runner, opts.alias, probe);
    nodePath = windowsNodeExe(probe.home);
  }

  if (probe.bundleVersion !== opts.bundleVersion) {
    report('deploying the host');
    await uploadWindowsBundles(
      runner,
      opts.alias,
      probe.home,
      { host: Buffer.from(opts.bundles.host), agent: Buffer.from(opts.bundles.agent) },
      opts.bundleVersion,
    );
  }

  // `probe.home`, not `$env:USERPROFILE` computed on the far side: the machine
  // directory is one path and two beliefs about it is what `AGBRTE_HOME` exists
  // to prevent (§8) — `startWindowsHost` tells the host this same value.
  let record = await readWindowsHostRecord(runner, opts.alias, opts.workspaceRoot, probe.home);
  if (record === null) {
    report('starting the host');
    record = await startWindowsHost(runner, opts.alias, probe.home, nodePath, opts.workspaceRoot, {
      ...(opts.lingerMs !== undefined ? { lingerMs: opts.lingerMs } : {}),
    });
  }

  report('opening the tunnel');
  const port = await freeLoopbackPort();
  const forward = await runner.forward(opts.alias, port, `127.0.0.1:${record.port}`);

  try {
    const channel = await connectLoopback<SessionCommand, SessionMessage>(
      port,
      record.token,
      10_000,
    );
    const connection = new HostConnection({
      channel,
      client: opts.client ?? `agbrte-app@${opts.alias}`,
      // The folder this connection is asking for. See the header.
      workspace: opts.workspaceRoot,
      onClose: () => forward.close(),
    });
    return { connection, close: () => forward.close() };
  } catch (err) {
    forward.close();
    throw err;
  }
}
