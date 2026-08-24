/**
 * Reaching a session host over SSH (DESIGN.md §6.2, §6.4, §14).
 *
 * ## The far end has to be POSIX, and that is not a detail
 *
 * §6.3 puts the loop **on the remote**: the agent host is installed on the
 * machine it controls, which is what makes tool calls microseconds rather than a
 * round trip and what lets a run survive a closed laptop. That is the design
 * working as intended, and it has a consequence worth stating rather than
 * leaving to be discovered — **everything below assumes a POSIX shell on the
 * other side.**
 *
 * Five independent places, none of which degrade gracefully:
 *
 *   * the probe runs `uname`, `command -v` and `[ -x … ]`
 *   * `nodeTarballUrl` fetches a `linux` or `darwin` build, as a `.tar.xz`
 *   * the launch uses `nohup setsid`, `mkdir -p`, `seq` and `sleep 0.5`
 *   * the bundle is uploaded with `cat > …`
 *   * the host listens on a **unix socket**, and `ssh -L` cannot forward a
 *     Windows named pipe
 *
 * So a Linux or macOS server works and **a Windows server cannot be attached at
 * all**. Every piece needed to change that now exists — §6.2's loopback control
 * channel replaces the unix socket, and the rest is a second bootstrap — but it
 * is unbuilt, and until it is this refuses with a sentence naming the reason
 * instead of a shell error somebody has to interpret.
 *
 * Shells out to the user's own `ssh` rather than speaking the protocol in
 * process. §14 specifies `ssh2` as the default and this as the fallback; the
 * order is reversed here deliberately, and the reason is the one thing that
 * makes remote hosts usable at all: **everything hard is already configured on
 * the user's machine.** `ProxyCommand`, jump chains, FIDO keys, `ssh-agent`,
 * `known_hosts`, host aliases. Going through a library means reimplementing all
 * of it — host-key TOFU UI included — and every one of those is a chance to be
 * subtly worse than what already works in their terminal.
 *
 * ## Shape, verified against a real host before it was written
 *
 * The remote host listens on a **unix socket** in its own home directory, and
 * the app reaches it with `ssh -L 127.0.0.1:<port>:<remote socket>`. A unix
 * socket rather than a remote TCP port because a TCP listener is reachable by
 * every user on that machine, which for a shared build box is the whole problem
 * (§17 Q9). That `-L` form was tested against a live server first: the design
 * rests on it, so guessing would have been expensive.
 *
 * The one concession is that the *local* end of the forward is TCP on loopback.
 * OpenSSH can forward a local unix socket too, but not portably on Windows, and
 * an ephemeral loopback port is a much smaller exposure than a remote one — it
 * is reachable only from this machine, and only while the app is running.
 *
 * ## Bootstrap without root
 *
 * Nothing is installed system-wide and nothing needs `sudo`. A private Node
 * runtime is unpacked under `~/.agbrte/` and the host bundle beside it. That
 * matters for a machine you were lent rather than given: attaching a host must
 * not mean changing it.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { readFile } from 'node:fs/promises';
import { LEGACY_WORKSPACE_DIR, WORKSPACE_DIR } from '@main/store/layout.js';

/**
 * How Agbrte is laid out in a remote home directory.
 *
 * Built from the absolute `$HOME` the probe reports rather than from `~`,
 * because the two do not survive quoting together: a path must be quoted to be
 * safe in `sh -c`, and quoting is exactly what stops the shell expanding `~`.
 * A literal `~/.agbrte/...` reaches the remote as a directory name containing a
 * tilde, and the failure — "No such file or directory" — points at the wrong
 * thing entirely.
 */
export function remoteRoot(home: string): string {
  return `${home}/.agbrte`;
}
export function remoteNodeDir(home: string): string {
  return `${remoteRoot(home)}/node`;
}
export function remoteBundle(home: string): string {
  return `${remoteRoot(home)}/agbrteHost.js`;
}
/**
 * The agent host, deployed beside the session host.
 *
 * Two files because the session host *forks* this one: it owns the log, so an
 * adapter crashing must not reach it (§8). Shipping only the session host left
 * the fork with nothing to exec, which surfaced as "could not resolve
 * capabilities: agent host exited with code 1" — a message about the wrong layer.
 */
export function remoteAgentBundle(home: string): string {
  return `${remoteRoot(home)}/agentHost.js`;
}
export function remoteNodeBin(home: string): string {
  return `${remoteNodeDir(home)}/bin/node`;
}
/**
 * Agbrte's own CLI, deployed beside the host (§7).
 *
 * A third file, and the reason it is worth one: the terminal pane can run *our*
 * CLI attached to the session, which is the only program in that pane that is a
 * client rather than something running next to the work — and `programs.ts`
 * looks for it beside the bundle that starts it. On a remote there was nothing
 * beside the bundle, so a machine could run a vendor CLI it happened to have and
 * not the one we ship.
 */
export function remoteCliBundle(home: string): string {
  return `${remoteRoot(home)}/agbrte.js`;
}
/** Where a deployed `node_modules` goes, so `createRequire` finds it (§6.2). */
export function remoteModulesDir(home: string): string {
  return `${remoteRoot(home)}/node_modules`;
}

/** Node shipped to a remote that has none. Pinned so a host is reproducible. */
export const REMOTE_NODE_VERSION = 'v22.11.0';

export interface SshRunner {
  /**
   * Run a command on the remote, returning its output.
   *
   * `timeoutMs` kills the `ssh` and resolves with **whatever had already
   * arrived**, under code `124` — `timeout(1)`'s number, chosen so one value
   * means "cut short" whichever side did the cutting. It exists for
   * `discoverWorkspaces`, where a slow machine must produce a short list marked
   * as short rather than a hang: every other caller here runs a command with its
   * own bound and passes nothing.
   *
   * Optional on the interface rather than required, so the fake runners the
   * tests inject stay two lines long.
   */
  exec(
    alias: string,
    command: string,
    opts?: {
      timeoutMs?: number;
      /**
       * Standard output as it arrives, in addition to the buffered result.
       *
       * Added for `provision.ts`, which runs one script whose steps take
       * minutes and must be reported while they happen. The streaming was
       * always here — `systemSshRunner` accumulates from a `data` handler — it
       * simply had no way out, so a caller wanting progress had to split one
       * command into six and pay six connection setups for it.
       *
       * Optional on the interface, so the fake runners the tests inject stay
       * two lines long and ignoring it is the correct default.
       */
      onData?: (chunk: string) => void;
    },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Copy local bytes to a remote path. */
  upload(alias: string, remotePath: string, contents: Buffer): Promise<void>;
  /**
   * Start `ssh -L`, resolving once the forward is usable.
   *
   * `remoteTarget` is either a socket path — how the host itself is reached —
   * or `host:port`, which is what §6.8's preview forwarding needs. OpenSSH takes
   * both in the same position, so one runner serves both and there is no second
   * code path to keep in step.
   */
  forward(alias: string, localPort: number, remoteTarget: string): Promise<{ close(): void }>;
}

export class RemoteBootstrapFailed extends Error {
  constructor(
    reason: string,
    readonly detail?: string,
  ) {
    super(detail === undefined || detail === '' ? reason : `${reason}: ${detail}`);
    this.name = 'RemoteBootstrapFailed';
  }
}

/**
 * Why a connection failed, and what the user can do about it.
 *
 * There is no ssh configuration to "have" — `ssh user@host` works with none at
 * all — but there are four distinct ways a first connection fails, and they need
 * four different actions. Reporting the raw stderr for all of them is accurate
 * and useless: "Host key verification failed" and "Permission denied (publickey)"
 * are the same sentence to someone who has not met them before, and both read as
 * "this app is broken".
 *
 * The classifications come from the messages OpenSSH actually produced against a
 * live host, not from guessing at them.
 */
export type SshFailureKind =
  | 'no-ssh-client'
  /** Reached, authenticated, and not a machine this bootstrap can run on. */
  | 'non-posix-remote'
  | 'unknown-host-key'
  | 'auth-refused'
  | 'name-resolution'
  | 'unreachable'
  | 'unknown';

export interface SshDiagnosis {
  kind: SshFailureKind;
  /** What happened, in the user's terms rather than ssh's. */
  summary: string;
  /** What they do next. */
  fix: string;
  /** Copy-pasteable, when one command settles it. */
  command?: string;
}

export function diagnoseSshFailure(alias: string, detail: string): SshDiagnosis {
  const text = detail.toLowerCase();

  /**
   * A **local** ssh that will not start. Narrowed to `ENOENT`, which is what
   * Node reports when the binary is missing.
   *
   * This also matched `not recognized` and `command not found`, and those are
   * the *remote* shell's words rather than ours — a Windows server answers
   * `'uname' is not recognized as an internal or external command`, and the user
   * was told "No ssh client was found on this machine" and sent to install
   * OpenSSH locally. The only thing worse than an unhelpful error is one that
   * names the wrong machine with confidence.
   */
  if (text.includes('enoent')) {
    return {
      kind: 'no-ssh-client',
      summary: 'No ssh client was found on this machine.',
      fix:
        'Install OpenSSH — it ships with macOS and most Linux, and on Windows it is ' +
        'an optional feature (Settings › Apps › Optional features › OpenSSH Client).',
    };
  }

  /**
   * The connection worked and the shell on the other side ran nothing we sent.
   *
   * `cmd.exe` says "is not recognized as an internal or external command";
   * PowerShell says "is not recognized as the name of a cmdlet". Either way ssh
   * authenticated fine and the machine simply cannot run what was sent, which is
   * a different problem from everything else in this list and deserves its own
   * sentence rather than the nearest one.
   *
   * ## What this used to say, and why it had to change
   *
   * It said "Agbrte bootstraps a remote host through a POSIX shell, so Linux and
   * macOS targets work and a Windows one is not supported yet", which was true
   * when written and is now the opposite of true. Worse, it is unreachable for
   * the case it names: `connectRemoteHost` asks the Windows probe *before* it
   * classifies anything, so a Windows remote attaches and never arrives here.
   *
   * Reaching this branch now means **both** bootstraps were refused — so the
   * remote is neither a POSIX shell nor PowerShell. A restricted shell
   * (`git-shell`, `rbash`), a network appliance's CLI, or a forced command in
   * `authorized_keys` all land here, and all of them are configuration on the
   * remote rather than anything about ssh or this app.
   *
   * A stale message of this kind is more expensive than no message: it is
   * confident, specific, and sends the reader somewhere the answer is not.
   */
  if (
    text.includes('not recognized') ||
    text.includes('command not found') ||
    text.includes('cmdlet')
  ) {
    return {
      kind: 'non-posix-remote',
      summary: `${alias} answered, but its shell could not run what was sent.`,
      // Deliberately not phrased as a fault. The connection is fine and the
      // credentials are fine; what is missing is a shell that can install
      // anything, and the user should not go looking at their keys for it.
      fix:
        'Agbrte installs a host through a POSIX shell or PowerShell, and this remote ' +
        'offered neither — a restricted shell such as git-shell or rbash, an appliance ' +
        'CLI, or a forced command in authorized_keys will all do this. Nothing is wrong ' +
        'with the connection or your credentials.',
    };
  }

  if (text.includes('host key verification failed') || text.includes('remote host identification')) {
    return {
      kind: 'unknown-host-key',
      summary: `This machine's identity has not been confirmed yet.`,
      // Deliberately not offered as a button. Trust-on-first-use only means
      // something if a human checks the fingerprint against something other than
      // the connection presenting it — accepting it for them would turn a real
      // check into a formality.
      fix:
        'Connect once from a terminal, check the fingerprint it shows against the ' +
        'machine itself, and accept it. Agbrte will not accept a key on your behalf.',
      command: `ssh ${alias}`,
    };
  }

  if (text.includes('permission denied') || text.includes('too many authentication failures')) {
    return {
      kind: 'auth-refused',
      summary: 'The machine refused the credentials this computer offered.',
      // Agbrte cannot prompt for a password: it runs ssh with BatchMode so that a
      // prompt fails fast instead of hanging on a stdin nobody is attached to.
      fix:
        'Install your public key on it, then try again. If you have no key yet, ' +
        'run `ssh-keygen` first.',
      command: `ssh-copy-id ${alias}`,
    };
  }

  if (text.includes('could not resolve hostname') || text.includes('name or service not known')) {
    return {
      kind: 'name-resolution',
      summary: `The name "${alias}" does not resolve to a machine.`,
      fix:
        'Check the spelling, or use user@hostname directly. A name only works if ' +
        'DNS knows it or your ~/.ssh/config defines it.',
    };
  }

  if (
    text.includes('connection timed out') ||
    text.includes('connection refused') ||
    text.includes('no route to host') ||
    text.includes('operation timed out')
  ) {
    return {
      kind: 'unreachable',
      summary: 'The machine did not answer.',
      fix: 'Check it is powered on and reachable from here — a VPN, a firewall, or a non-default port would all do this.',
    };
  }

  return {
    kind: 'unknown',
    summary: `Could not reach ${alias}.`,
    fix: 'The message from ssh is below; running the same command in a terminal usually says more.',
    command: `ssh ${alias}`,
  };
}

/** A diagnosis rendered as the one string that survives an IPC boundary. */
export function describeSshFailure(alias: string, detail: string): string {
  const d = diagnoseSshFailure(alias, detail);
  const parts = [d.summary, d.fix];
  if (d.command !== undefined) parts.push(`Try: ${d.command}`);
  // Only the first line: ssh is often chatty after the sentence that matters,
  // and the rest pushes the actionable part off the end of a one-line error.
  const first = detail.trim().split(/\r?\n/)[0];
  if (first !== undefined && first !== '') parts.push(`(ssh said: ${first})`);
  return parts.join(' ');
}

/** What a remote already has, decided by looking rather than assuming. */
export interface RemoteProbe {
  reachable: boolean;
  /** `uname -m`, so the right Node build is fetched. */
  arch: string;
  platform: string;
  /** A usable `node`, whether the system's or one Agbrte unpacked earlier. */
  nodePath: string | null;
  /** True when the host bundle is already in place at the expected version. */
  bundleVersion: string | null;
  home: string;
  detail: string;
}

/**
 * One shell round trip that answers everything the bootstrap decides on.
 *
 * Batched deliberately: each `ssh` invocation is a full connection setup, and
 * five sequential probes is five of them — noticeable on a link with any
 * latency, and the whole point of remote execution is that latency is the enemy
 * (§6.3).
 */
export async function probeRemote(runner: SshRunner, alias: string): Promise<RemoteProbe> {
  const script = [
    'echo "home=$HOME"',
    'echo "arch=$(uname -m)"',
    'echo "platform=$(uname -s)"',
    // A Agbrte-managed Node is preferred over the system one: it is the version
    // this host was tested with, and a system upgrade cannot move it underneath.
    `if [ -x "$HOME/.agbrte/node/bin/node" ]; then echo "node=$HOME/.agbrte/node/bin/node"; ` +
      'elif command -v node >/dev/null 2>&1; then echo "node=$(command -v node)"; ' +
      'else echo "node="; fi',
    `if [ -f "$HOME/.agbrte/agbrteHost.js" ]; then echo "bundle=$(sed -n 's/^\\/\\/ agbrte-bundle: //p' "$HOME/.agbrte/agbrteHost.js" | head -1)"; else echo "bundle="; fi`,
  ].join('; ');

  const result = await runner.exec(alias, script);
  if (result.code !== 0) {
    return {
      reachable: false,
      arch: '',
      platform: '',
      nodePath: null,
      bundleVersion: null,
      home: '',
      detail: result.stderr.trim() || `ssh exited ${result.code}`,
    };
  }

  const fields = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  const node = fields.get('node') ?? '';
  const bundle = fields.get('bundle') ?? '';
  return {
    reachable: true,
    arch: fields.get('arch') ?? '',
    platform: fields.get('platform') ?? '',
    nodePath: node === '' ? null : node,
    bundleVersion: bundle === '' ? null : bundle,
    home: fields.get('home') ?? '',
    detail: result.stdout.trim(),
  };
}

/** Node's own download URL for a platform triple. */
export function nodeTarballUrl(platform: string, arch: string, version = REMOTE_NODE_VERSION): string {
  const os = platform.toLowerCase() === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'x64';
  return `https://nodejs.org/dist/${version}/node-${version}-${os}-${cpu}.tar.xz`;
}

/**
 * Put a private Node under `~/.agbrte/node`, without touching the system.
 *
 * `--strip-components=1` so the version disappears from the path: the caller
 * should not have to know which build is unpacked, and an upgrade replaces the
 * directory rather than adding a second one to choose between.
 */
export async function installRemoteNode(
  /**
   * `exec` only, because that is all this uses.
   *
   * Narrowed when `provision.ts` began calling it with a runner that has no
   * `upload` and no `forward` — a local machine needs neither, and widening the
   * local runner to satisfy a type it never exercises would mean two methods
   * that exist to throw. Every existing caller passes a full `SshRunner`, which
   * still satisfies this.
   */
  runner: Pick<SshRunner, 'exec'>,
  alias: string,
  probe: RemoteProbe,
): Promise<void> {
  const url = nodeTarballUrl(probe.platform, probe.arch);
  const dir = shellQuote(remoteNodeDir(probe.home));
  const script = [
    `mkdir -p ${dir}`,
    `cd "$(mktemp -d)"`,
    // `-f` so an HTTP error is a non-zero exit rather than a saved error page,
    // which would then fail confusingly inside tar.
    `curl -fsSL "${url}" -o node.tar.xz`,
    `tar -xJf node.tar.xz -C ${dir} --strip-components=1`,
    `rm -f node.tar.xz`,
    `${shellQuote(remoteNodeBin(probe.home))} --version`,
  ].join(' && ');

  const result = await runner.exec(alias, script);
  if (result.code !== 0) {
    throw new RemoteBootstrapFailed('could not install Node on the remote', result.stderr.trim());
  }
}

/**
 * The pty module this build expects, pinned.
 *
 * Read from the app's own dependency rather than written twice: the host bundle
 * calls `require('@lydell/node-pty')` and gets whatever is beside it, so a
 * remote holding a different version is a remote running code this build has
 * never loaded.
 */
export const REMOTE_PTY_VERSION = '1.2.0-beta.15';

/** The platform package npm publishes for one machine. */
export function ptyPackageFor(platform: string, arch: string): string {
  const os = platform.toLowerCase() === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'x64';
  return `node-pty-${os}-${cpu}`;
}

/** Where npm serves a scoped package's tarball. */
export function ptyTarballUrl(name: string, version = REMOTE_PTY_VERSION): string {
  return `https://registry.npmjs.org/@lydell/${name}/-/${name}-${version}.tgz`;
}

/**
 * Put the pty module under `~/.agbrte/node_modules`, so a remote can open a
 * terminal (§7).
 *
 * ## Why this is a download and not an upload
 *
 * A prebuild is per platform *and* architecture, and the app only ever has the
 * one npm installed for the machine it is running on — a Windows laptop
 * deploying to a Linux build box has no Linux binary to send. Fetching it where
 * it is needed is the same act as the private Node three functions up: a pinned
 * version, over TLS, from the project's own registry, into `~/.agbrte` and
 * nowhere else. It adds a second host to trust and no new *kind* of trust, which
 * is the honest way to state it.
 *
 * ## Why it lands in `node_modules` rather than somewhere of our choosing
 *
 * `shell.ts` loads it with `createRequire(import.meta.url)` from the deployed
 * bundle, so Node walks up from `~/.agbrte/` and finds `~/.agbrte/node_modules`.
 * Putting it there means the remote and the local machine load it the same way,
 * and nothing in the host has to know it was deployed.
 *
 * Both packages, because the main one is a shim that requires the platform one
 * by name. `--strip-components=1` drops npm's `package/` prefix.
 *
 * **Failure is not fatal to a deploy.** A machine with no route to the registry,
 * or an architecture with no prebuild, is a machine that cannot open a terminal
 * — which the host reports and the UI says (§6.8's rule: name what is missing,
 * do not hide the control). Everything else about that host works, and refusing
 * to attach would trade a session for a pane.
 */
export async function installRemotePty(
  runner: Pick<SshRunner, 'exec'>,
  alias: string,
  probe: RemoteProbe,
  /** Called only when there is something to wait for — see the check below. */
  report: (step: string) => void = () => undefined,
): Promise<{ installed: boolean; detail?: string }> {
  /*
   * Asked before fetched, because this is called on **every** attach.
   *
   * It used to sit inside the "deploy the bundles" branch, which is guarded by
   * a version stamp — so a machine that already carried this build never got the
   * module, and the terminal stayed dark on exactly the remotes that had been
   * attached before. The download belongs behind a check about *the module*, not
   * behind one about the bundles.
   *
   * One `require` over ssh when it is present, which is the common case.
   */
  const present = await runner.exec(
    alias,
    `cd ${shellQuote(remoteRoot(probe.home))} && ${shellQuote(remoteNodeBin(probe.home))} -e "require('@lydell/node-pty')"`,
  );
  if (present.code === 0) return { installed: true };

  report('deploying the terminal module');
  const platformPkg = ptyPackageFor(probe.platform, probe.arch);
  // Each path quoted whole rather than a quoted prefix with a bare tail: both
  // are valid shell and only one is readable in a log somebody is debugging.
  const mainDir = shellQuote(`${remoteModulesDir(probe.home)}/@lydell/node-pty`);
  const platformDir = shellQuote(`${remoteModulesDir(probe.home)}/@lydell/${platformPkg}`);
  const script = [
    `mkdir -p ${mainDir} ${platformDir}`,
    `cd "$(mktemp -d)"`,
    `curl -fsSL "${ptyTarballUrl('node-pty')}" -o main.tgz`,
    `curl -fsSL "${ptyTarballUrl(platformPkg)}" -o platform.tgz`,
    `tar -xzf main.tgz -C ${mainDir} --strip-components=1`,
    `tar -xzf platform.tgz -C ${platformDir} --strip-components=1`,
    `rm -f main.tgz platform.tgz`,
    // Proved rather than assumed: an extracted tree is not a loadable module,
    // and the difference shows up later as a terminal that will not open.
    `cd ${shellQuote(remoteRoot(probe.home))} && ${shellQuote(remoteNodeBin(probe.home))} -e "require('@lydell/node-pty')"`,
  ].join(' && ');

  const result = await runner.exec(alias, script);
  if (result.code === 0) return { installed: true };
  return { installed: false, detail: result.stderr.trim().slice(0, 400) };
}

/**
 * Copy both bundles, stamping the session host so a later probe knows what is
 * deployed.
 *
 * Only the session host carries the stamp: the two always ship together, so one
 * marker answers for both.
 */
export async function uploadHostBundle(
  runner: SshRunner,
  alias: string,
  home: string,
  bundles: { host: string; agent: string; cli?: string },
  version: string,
): Promise<void> {
  const [hostBytes, agentBytes, cliBytes] = await Promise.all([
    readFile(bundles.host),
    readFile(bundles.agent),
    bundles.cli === undefined ? Promise.resolve(null) : readFile(bundles.cli),
  ]);
  // The stamp is a comment on the first line, which is why the probe can read
  // the deployed version with `sed` instead of running the bundle.
  const stamped = Buffer.concat([Buffer.from(`// agbrte-bundle: ${version}\n`), hostBytes]);

  // `chmod 700` alongside the `mkdir`, because §13 says `~/.agbrte` is 0700 and
  // `mkdir -p` leaves it at the umask — 0755 on an ordinary machine. It mattered
  // less when the directory held a Node runtime and a bundle; `endpoints.json`
  // with an API key now lives here too, and a 0600 file under a 0755 directory
  // is still a directory every account on a build box can list.
  await runner.exec(
    alias,
    `mkdir -p ${shellQuote(remoteRoot(home))} && chmod 700 ${shellQuote(remoteRoot(home))}`,
  );
  await runner.upload(alias, remoteAgentBundle(home), agentBytes);
  // Optional so a caller that has no CLI to send — a test, an older embedder —
  // deploys what it has rather than failing. Before the stamp, like the agent
  // host: the stamp means "everything this version ships is here".
  if (cliBytes !== null) await runner.upload(alias, remoteCliBundle(home), cliBytes);
  // The session host is written last: the probe reads its stamp as "both are
  // deployed", so writing it first would make a half-deployment look complete.
  await runner.upload(alias, remoteBundle(home), stamped);
}

/**
 * Start the host detached and return the record it wrote once listening.
 *
 * **The wait happens on the remote, inside the same command.** Backgrounding and
 * letting `ssh` return immediately kills the child: it starts, reaches `listen`,
 * and dies the moment the session closes — verified against a real host, where
 * the log showed "listening" and the process was gone seconds later. Holding the
 * session open until the host has written its record gets it past that point,
 * after which it survives independently (also verified: the process outlived the
 * session that started it).
 *
 * Doing the waiting remotely rather than polling over SSH also removes up to
 * forty connection setups from a first attach, which on a latent link is the
 * difference between "a moment" and "did it hang?".
 *
 * `setsid` puts it in its own session so a group signal cannot reach it, and
 * `nohup` covers the SIGHUP that arrives before that takes effect.
 */
export async function startRemoteHost(
  runner: SshRunner,
  alias: string,
  home: string,
  nodePath: string,
  workspaceRoot: string,
  opts: { lingerMs?: number; readyTimeoutMs?: number } = {},
): Promise<RemoteHostRecord> {
  const linger = opts.lingerMs === undefined ? '' : `AGBRTE_HOST_LINGER_MS=${opts.lingerMs} `;
  /*
   * Told where its machine directory is, rather than left to work it out (§8).
   *
   * The app computes `remoteRoot(home)` from the `$HOME` its probe reported and
   * then looks for `host.json` there; the host computes `machineRoot()` from its
   * own environment. Those agree by default and are two beliefs rather than one,
   * which is precisely the disagreement `AGBRTE_HOME` exists to prevent — and it
   * is not hypothetical on the far side, where `ssh <alias> '<command>'` runs a
   * non-interactive non-login shell whose `$HOME` is whatever sshd says it is.
   * Passing it makes the app's belief the *instruction*.
   */
  const machineHome = `AGBRTE_HOME=${shellQuote(remoteRoot(home))} `;
  const log = shellQuote(`${remoteRoot(home)}/host.log`);
  /*
   * Where a started host says it is listening, in the order it writes them.
   *
   * The machine's own record first (§8) — a host is one per machine and
   * `~/.agbrte/host.json` is the record it writes about itself. The workspace's
   * two names after it, because §5.1 reads the old one forever and because a
   * host from before v21, deployed on this machine last week and still running,
   * writes only there. Waiting on the machine record alone would time out
   * against a host that had already started; waiting on the workspace records
   * alone would have missed the new one entirely, since it writes the machine
   * record first and the pointer a moment later.
   */
  const records = [
    shellQuote(`${remoteRoot(home)}/host.json`),
    ...[WORKSPACE_DIR, LEGACY_WORKSPACE_DIR].map((d) =>
      shellQuote(`${workspaceRoot}/${d}/host.json`),
    ),
  ];
  const attempts = Math.max(1, Math.ceil((opts.readyTimeoutMs ?? 30_000) / 500));

  // Assembled with explicit separators rather than joined on '; ': `&` already
  // terminates a command, so a blanket join produces `... &; for ...`, which is
  // a syntax error rather than a background job.
  // The launch is wrapped in `( … ) >/dev/null 2>&1` for a reason that costs an
  // afternoon to find: a backgrounded subshell inherits the SSH channel's stdout
  // and stderr, and `ssh` does not return until every holder of those closes. The
  // host is long-lived, so `ssh` hangs forever — the command has succeeded and
  // the caller never learns. Detaching the subshell's fds lets the channel close
  // while the host keeps running.
  const launch =
    `( ${machineHome}${linger}nohup setsid ${shellQuote(nodePath)} ${shellQuote(remoteBundle(home))} ` +
    `${shellQuote(workspaceRoot)} >${log} 2>&1 < /dev/null & ) >/dev/null 2>&1`;

  const command =
    // Created if absent, matching the local flow — its folder picker allows
    // making one. Refusing instead would mean the user has to ssh in and mkdir,
    // which is the friction this is supposed to remove.
    `mkdir -p ${shellQuote(workspaceRoot)} && cd ${shellQuote(workspaceRoot)} && ` +
    // Truncated up front so a failure before launch cannot show the *previous*
    // run's log. A stale "listening" line under a startup failure is actively
    // misleading — it says the thing that just failed worked.
    `: > ${log}; ${launch}; ` +
    // The record is written only once the socket is accepting, so waiting for it
    // is waiting for readiness — not merely for the process to exist. Waiting
    // here also keeps the session open past the moment a freshly started child
    // would otherwise be killed by it closing.
    `for i in $(seq 1 ${attempts}); do ` +
    `for r in ${records.join(' ')}; do ` +
    `if [ -s "$r" ]; then cat "$r"; exit 0; fi; done; sleep 0.5; done; ` +
    `echo TIMEOUT >&2; tail -20 ${log} >&2; exit 1`;

  const started = await runner.exec(alias, command);
  if (started.code !== 0) {
    throw new RemoteBootstrapFailed('remote host never started listening', started.stderr.trim());
  }

  try {
    return JSON.parse(started.stdout) as RemoteHostRecord;
  } catch {
    throw new RemoteBootstrapFailed(
      'the remote host wrote an unreadable record',
      started.stdout.trim(),
    );
  }
}

/**
 * Where a remote host is listening, and whatever else could be learned.
 *
 * `socket` is the only field required, and that is a statement about how a host
 * is found rather than a convenience. The rest comes from a record **file**, and
 * a machine can be serving perfectly well with no readable record on it — see
 * `FIND_HOST_SCRIPT`, which will then find the host by its socket alone. Typing
 * `pid` as always-present would have meant inventing one at exactly the moment
 * the truth is "a host answered and did not say".
 *
 * Nothing on the attach path reads anything but `socket`: the handshake is where
 * a client learns the pid, the protocol and the workspace, and it learns them
 * from the host rather than from a file the host wrote at some earlier time.
 */
export interface RemoteHostRecord {
  socket: string;
  pid?: number;
  protocol?: number;
  instanceId?: string;
  /**
   * Which machine's host wrote it (§8).
   *
   * Absent from a host deployed before v21, and that absence is the test the
   * client uses to tell a per-workspace host from the machine's — see
   * `legacyHost.ts`. Not defaulted, for that reason.
   */
  machineId?: string;
}

/**
 * Find the machine's live host, run by the remote's own Node.
 *
 * ## A record is a hint; a socket answering is a fact
 *
 * This was `cat host.json`, and a file is the wrong kind of evidence for the
 * question being asked. Both ways of being wrong were reachable, and both left
 * a machine that could not be attached to at all:
 *
 *   * **A record that lies.** A host killed with `kill -9`, or gone with the
 *     machine it ran on, leaves the file behind. The app read it, forwarded to a
 *     socket nobody answers, and failed — every time, for good, because a record
 *     that exists is a reason not to start a host.
 *   * **A live host with no record.** `~/.agbrte/host.json` can be missing while
 *     a host is listening — a lost bind race used to delete it (see
 *     `clearIfOurs`), and anything that empties `/tmp`-adjacent state can too.
 *     The app then started a second host, which the first one's socket refuses,
 *     and reported that refusal to a person who never asked to start anything.
 *
 * So: read every record this machine could have written, and return the first
 * one whose socket **accepts a connection**. The candidates are the machine's
 * own record, the requested folder's pointer, and the pointer in every folder
 * `workspaces.json` says this machine has served — which is what makes attaching
 * a *new* folder work on a machine whose machine-record has gone missing, the
 * case that produced this.
 *
 * ## And when there is no record anywhere
 *
 * One more candidate, tried last: the socket path a host on this machine
 * *would* choose. It is not a guess — `hostSocketPath` derives it from
 * `machine.json`, which is the machine's identity and not a record, so nothing
 * that clears records clears it. This is the state the bug actually left
 * machines in: a host holding four folders lost the bind race, and the cleanup
 * it ran on the way out deleted the machine record **and every pointer**,
 * because it had restored all four workspaces before it tried to bind. Nothing
 * on disk then said where the host was, while it went on answering.
 *
 * Safe to try precisely because the answer is proved by connecting. A derived
 * path that nothing is listening on costs one failed `connect` and produces the
 * same "no host here" as before, which is the correct answer for a machine that
 * has none.
 *
 * Run as one script on the far side rather than as five round trips, and on the
 * Node this attach has already guaranteed. A `sh` cannot connect to a unix
 * socket; the alternative — believing the file and finding out during the
 * handshake — is what the two failures above already are.
 *
 * POSIX only. A Windows remote has `readWindowsHostRecord`, whose record carries
 * a loopback port and a bearer token instead of a socket path, and which has the
 * same weakness for the same reason (§17 Q22).
 */
export const FIND_HOST_SCRIPT = [
  'const fs=require("fs"),path=require("path"),net=require("net");',
  'const home=process.argv[1],ws=process.argv[2];',
  `const dirs=${JSON.stringify([WORKSPACE_DIR, LEGACY_WORKSPACE_DIR])};`,
  'const files=[path.join(home,"host.json")];',
  'for(const d of dirs)files.push(path.join(ws,d,"host.json"));',
  'try{const reg=JSON.parse(fs.readFileSync(path.join(home,"workspaces.json"),"utf8"));',
  'for(const w of reg.workspaces||[])if(w&&typeof w.root==="string")',
  'for(const d of dirs)files.push(path.join(w.root,d,"host.json"))}catch(e){}',
  'const read=(p)=>{try{const r=JSON.parse(fs.readFileSync(p,"utf8"));',
  'return typeof r.socket==="string"&&typeof r.pid==="number"?r:null}catch(e){return null}};',
  // Last, and derived rather than read: the path a host on this machine would
  // listen on. Mirrors `hostSocketPath`'s POSIX branch — a Windows remote has
  // its own bootstrap and never runs this.
  'const derived=()=>{try{const m=JSON.parse(fs.readFileSync(path.join(home,"machine.json"),"utf8"));',
  'return typeof m.machineId==="string"?{socket:(process.env.TMPDIR||"/tmp")+"/agbrte-"+m.machineId+".sock",',
  'machineId:m.machineId}:null}catch(e){return null}};',
  'const answers=(s)=>new Promise((done)=>{const c=net.connect(s);',
  'const end=(v)=>{c.destroy();done(v)};c.once("connect",()=>end(true));',
  'c.once("error",()=>end(false));c.setTimeout(2000,()=>end(false))});',
  '(async()=>{const seen={};const found=[];',
  'for(const f of files){const rec=read(f);if(rec)found.push(rec)}',
  'const last=derived();if(last)found.push(last);',
  'for(const rec of found){if(seen[rec.socket])continue;seen[rec.socket]=1;',
  'if(await answers(rec.socket)){process.stdout.write(JSON.stringify(rec));break}}})();',
].join('');

/** Where this machine's host is listening, or null if none of them answers. */
export async function readRemoteHostRecord(
  runner: SshRunner,
  alias: string,
  workspaceRoot: string,
  home: string,
  nodePath: string,
): Promise<RemoteHostRecord | null> {
  const result = await runner.exec(
    alias,
    `${shellQuote(nodePath)} -e ${shellQuote(FIND_HOST_SCRIPT)} ` +
      `${shellQuote(remoteRoot(home))} ${shellQuote(workspaceRoot)}`,
  );
  if (result.code !== 0 || result.stdout.trim() === '') return null;
  try {
    return JSON.parse(result.stdout) as RemoteHostRecord;
  } catch {
    // A half-written record is indistinguishable from none, and treating it as
    // none is right: the next poll reads a complete one.
    return null;
  }
}

/** Quote a path for `sh -c`, which is what `ssh <host> <command>` runs. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An ephemeral loopback port, chosen by the OS so two hosts cannot collide. */
export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe: Server = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error('no port')) : resolve(port)));
    });
  });
}

/** The real runner: the user's `ssh`, with their config and their credentials. */
export function systemSshRunner(sshPath = 'ssh'): SshRunner {
  const base = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];

  const exec: SshRunner['exec'] = (alias, command, opts) =>
    new Promise((resolve) => {
      const child = spawn(sshPath, [...base, alias, command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        /*
         * No console window for a console program (§6.2).
         *
         * Windows gives a child its own console when the parent has none and the
         * spawn does not say otherwise, and on Windows 11 that console is a
         * Windows Terminal window. The packaged app is a GUI process with no
         * console, so every one of these would have flashed a black window at
         * somebody who asked for a remote connection and got a light show;
         * measured at 36 windows across one test run before this. stdio is piped
         * either way, so there was never anything to look at.
         */
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let cutShort = false;
      child.stdout.on('data', (d) => {
        stdout += d;
        // Both, never one or the other: a caller watching the stream still gets
        // the whole output at the end, and one that ignores it is unaffected.
        opts?.onData?.(String(d));
      });
      child.stderr.on('data', (d) => (stderr += d));
      /*
       * Kill, but keep what arrived.
       *
       * The output of a long command streams as it is produced, so a command cut
       * short at ten seconds has already delivered ten seconds of answer — and
       * for discovery that partial answer is the whole point: a list marked as
       * incomplete beats a spinner that never resolves. Killing the local `ssh`
       * closes the channel, and sshd ends the remote command with it.
       */
      const timer =
        opts?.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              cutShort = true;
              child.kill();
            }, opts.timeoutMs);
      const done = (result: { code: number; stdout: string; stderr: string }): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };
      child.on('error', (err) => done({ code: 127, stdout, stderr: err.message }));
      child.on('close', (code) =>
        done(cutShort ? { code: 124, stdout, stderr } : { code: code ?? 1, stdout, stderr }),
      );
    });

  const upload: SshRunner['upload'] = (alias, remotePath, contents) =>
    new Promise((resolve, reject) => {
      // `cat >` over the existing connection rather than `scp`: one code path,
      // and it inherits the same config and credentials as everything else here.
      const child = spawn(sshPath, [...base, alias, `cat > ${shellQuote(remotePath)}`], {
        stdio: ['pipe', 'ignore', 'pipe'],
        // A console window for an upload nobody can see into. See `exec` above.
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new RemoteBootstrapFailed(`upload to ${remotePath} failed`, stderr.trim())),
      );
      child.stdin.end(contents);
    });

  const forward: SshRunner['forward'] = async (alias, localPort, remoteTarget) => {
    const child = spawn(
      sshPath,
      [...base, '-N', '-L', `127.0.0.1:${localPort}:${remoteTarget}`, alias],
      // A forward outlives the call that made it, so its window would have
      // sat there for the life of the session. See `exec` above.
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    // `ssh -N` never says it is ready, so readiness is "the port answers".
    // Waiting a fixed time instead would be either slow or flaky depending on
    // the link.
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (await portAnswers(localPort)) return { close: () => child.kill() };
      if (child.exitCode !== null) {
        throw new RemoteBootstrapFailed('ssh forward exited', stderr.trim());
      }
      if (Date.now() > deadline) {
        child.kill();
        throw new RemoteBootstrapFailed('ssh forward never became usable', stderr.trim());
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  return { exec, upload, forward };
}

async function portAnswers(port: number): Promise<boolean> {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}
