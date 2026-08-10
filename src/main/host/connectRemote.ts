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
 */

import {
  describeSshFailure,
  freeLoopbackPort,
  installRemoteNode,
  probeRemote,
  readRemoteHostRecord,
  remoteNodeBin,
  RemoteBootstrapFailed,
  startRemoteHost,
  systemSshRunner,
  uploadHostBundle,
  type SshRunner,
} from './sshTransport.js';
import { connect } from '@shared/host/socketChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import { HostConnection } from './hostConnection.js';

export interface RemoteConnectOptions {
  /** An alias from the user's ssh config — `ssh <alias>` must work. */
  alias: string;
  /** Absolute path on the remote. */
  workspaceRoot: string;
  /** The built bundles to deploy: the session host and the agent host it forks. */
  bundles: { host: string; agent: string };
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
  if (!probe.reachable) {
    // Classified rather than passed through raw. "Host key verification failed"
    // and "Permission denied (publickey)" are the same sentence to someone who
    // has not met them before, and both read as "this app is broken" — while
    // needing completely different actions.
    throw new RemoteBootstrapFailed(describeSshFailure(opts.alias, probe.detail));
  }

  let nodePath = probe.nodePath;
  if (nodePath === null) {
    report('installing a private Node runtime (nothing system-wide)');
    await installRemoteNode(runner, opts.alias, probe);
    nodePath = remoteNodeBin(probe.home);
  }

  if (probe.bundleVersion !== opts.bundleVersion) {
    // Version-stamped rather than always uploaded: the bundle is ~100 KB, and
    // re-sending it on every attach is a needless round trip on a slow link.
    report('deploying the host');
    await uploadHostBundle(runner, opts.alias, probe.home, opts.bundles, opts.bundleVersion);
  }

  let record = await readRemoteHostRecord(runner, opts.alias, opts.workspaceRoot);

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
      onClose: () => forward.close(),
    });
    return { connection, close: () => forward.close() };
  } catch (err) {
    forward.close();
    throw err;
  }
}
