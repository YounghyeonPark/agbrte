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
  bundles: { host: string; agent: string },
  version: string,
): Promise<void> {
  const [hostBytes, agentBytes] = await Promise.all([
    readFile(bundles.host),
    readFile(bundles.agent),
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
  const log = shellQuote(`${remoteRoot(home)}/host.log`);
  const record = shellQuote(`${workspaceRoot}/.devagents/host.json`);
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
    `( ${linger}nohup setsid ${shellQuote(nodePath)} ${shellQuote(remoteBundle(home))} ` +
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
    `if [ -s ${record} ]; then cat ${record}; exit 0; fi; sleep 0.5; done; ` +
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

export interface RemoteHostRecord {
  pid: number;
  socket: string;
  protocol: number;
  instanceId: string;
}

/** Read the host's own record of where it is listening. */
export async function readRemoteHostRecord(
  runner: SshRunner,
  alias: string,
  workspaceRoot: string,
): Promise<RemoteHostRecord | null> {
  const result = await runner.exec(
    alias,
    `cat ${shellQuote(`${workspaceRoot}/.devagents/host.json`)} 2>/dev/null`,
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
      { stdio: ['ignore', 'ignore', 'pipe'] },
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
