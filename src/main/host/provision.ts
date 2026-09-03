/**
 * Making a machine able to run an agent (DESIGN.md §6.2, §6.4, §3.12, §3.8).
 *
 * ## The state this exists for
 *
 * A freshly attached ssh host answers `Add an agent` with three failures and no
 * way forward: *Claude Code … not detected (ENOENT)*, *Gemini CLI … not detected
 * (ENOENT)*, *0 found. local: fetch failed*. Every one of those sentences is
 * true, every one names a real absence, and none of them is actionable from
 * inside the app — the remedy was always "open a terminal on that machine".
 * A program that can reach a machine well enough to *diagnose* it can reach it
 * well enough to fix it, and the gap between those two was entirely ours.
 *
 * ## Built on the bootstrap, not beside it
 *
 * §6.4 already unpacks a private Node under `~/.agbrte/node` over ssh, without
 * root, without touching anything system-wide, reporting one line per step. That
 * is the same machinery every route here needs, so `installRemoteNode` is called
 * rather than reimplemented, the CLIs land under the same `~/.agbrte` root, and
 * progress is the same `(step) => void` the attach path already reports through.
 * A second installer with its own conventions would be a second thing to keep
 * true about a machine three time zones away.
 *
 * Three consequences that are properties of that inheritance rather than
 * choices made here:
 *
 *  - **Nothing needs `sudo`, and nothing is offered that would.** Ollama's own
 *    `install.sh` writes to `/usr/local` through `sudo`, so it is not used; the
 *    release tarball is unpacked under `~/.agbrte/ollama` exactly as Node is.
 *    npm installs with `--prefix ~/.agbrte/npm`, which is why a machine with no
 *    writable global prefix still works.
 *  - **The far end must be POSIX.** Every script here is `sh`, so a Windows
 *    remote is refused *by name* rather than sent a script `cmd.exe` will echo
 *    back and exit 0 on — the exact failure §6.2 records for the first Windows
 *    probe. See `RouteRefused`.
 *  - **No user input reaches a shell.** The two shell routes take a value from a
 *    closed set (`claude-code` | `gemini-cli`) and nothing else; the package
 *    name, the version, the URL and every path are constants or come from the
 *    probe. The model tag a person types goes to Ollama over HTTP through the
 *    host (§3.8), never through `sh`. This is a property worth asserting rather
 *    than remembering, and `tests/provision.test.ts` asserts it.
 *
 * ## Why the steps stream out of one connection
 *
 * Each `ssh` invocation is a full connection setup, which is why `probeRemote`
 * batches five questions into one. The same argument applies harder here: an
 * Ollama install is a ~1 GB download, and splitting it across six `ssh` calls to
 * get six progress lines would pay six connection setups for cosmetics. So each
 * route is one script that prints `@@step …` markers as it goes, and `exec`'s
 * `onData` — the streaming `systemSshRunner` already did internally and simply
 * never exposed — turns those into progress the moment they are printed. A
 * failing step prints `@@fail …` and the command's own stderr comes back
 * verbatim, so the sentence a user reads is the machine's, not ours.
 */

import {
  installRemoteNode,
  remoteNodeDir,
  remoteRoot,
  shellQuote,
  type RemoteProbe,
} from './sshTransport.js';

/** Enough of an `SshRunner` to set a machine up. No upload, no forward. */
export interface ProvisionRunner {
  exec(
    alias: string,
    command: string,
    opts?: { timeoutMs?: number; onData?: (chunk: string) => void },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The CLIs this can install, and nothing else may be named. */
export type InstallableCli = 'claude-code' | 'gemini-cli';

/**
 * What a person asked for.
 *
 * A closed union rather than a command string, which is the whole of the
 * "no user input reaches a shell" guarantee: there is no shape of this value
 * that carries shell syntax, so nothing downstream has to quote it correctly.
 * `endpoint` is here for symmetry of the *outcome* — it ends in the same
 * re-detect — but it never reaches a script: it is written by the host over the
 * session channel, because a credential must not cross a command line (§13).
 */
export type SetupPlan =
  | { kind: 'cli'; cli: InstallableCli }
  | { kind: 'ollama' }
  | {
      kind: 'endpoint';
      endpoint: {
        id: string;
        label?: string;
        provider: string;
        baseUrl: string;
        apiKey?: string;
        /** Which adapter speaks to it. Absent means `openai-compatible`. */
        api?: string;
      };
    };

/**
 * A plan safe to log, put in an error, or hand to a progress callback.
 *
 * Exists because `SetupPlan` is one union and exactly one arm of it carries a
 * secret. Anything that describes a plan calls this, so "remember not to print
 * the key" is a property of the type rather than of every call site — which is
 * the arrangement §6.5 asks for and the one that survives a later edit.
 */
export function describePlan(plan: SetupPlan): string {
  switch (plan.kind) {
    case 'cli':
      return `install ${CLI_PACKAGES[plan.cli].label}`;
    case 'ollama':
      return 'install Ollama';
    case 'endpoint':
      // Deliberately not spread: `...plan.endpoint` would carry `apiKey` into
      // every string built from this the moment somebody templated it.
      return `add the endpoint "${plan.endpoint.id}" (${plan.endpoint.provider})`;
  }
}

/**
 * A route that cannot run here, said before anything is attempted.
 *
 * Its own class because the reasons are different and only one of them is about
 * the user: an unsupported operating system, a transport that cannot hold a
 * daemon, or an app built without a provisioner. All are answers; none is a
 * failure of the machine.
 */
export class RouteRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RouteRefused';
  }
}

/** A step failed on the far side. Carries the machine's own words. */
export class SetupFailed extends Error {
  constructor(
    /** The `@@step` that was running, so a half-finished install names its half. */
    readonly step: string,
    reason: string,
    readonly detail: string,
  ) {
    super(detail === '' ? reason : `${reason}: ${detail}`);
    this.name = 'SetupFailed';
  }
}

// ------------------------------------------------------------------- layout

/** npm's `--prefix`, so nothing needs a writable global directory or `sudo`. */
export function managedNpmPrefix(home: string): string {
  return `${remoteRoot(home)}/npm`;
}
/** Where npm links the shims it creates. Appended to the host's PATH. */
export function managedCliBin(home: string): string {
  return `${managedNpmPrefix(home)}/bin`;
}
export function managedOllamaDir(home: string): string {
  return `${remoteRoot(home)}/ollama`;
}

/**
 * The npm packages, pinned by *name* and deliberately not by version.
 *
 * A vendor CLI is a thing the user wants current — its protocol is the vendor's
 * to change and the manifests in `runtime/cli/` track the latest — so pinning
 * one here would install a build our own adapter has moved past. The Node
 * runtime is pinned for the opposite reason: it is ours, and a host has to be
 * reproducible.
 */
export const CLI_PACKAGES: Readonly<
  Record<InstallableCli, { pkg: string; binary: string; label: string; runtimeId: string }>
> = {
  'claude-code': {
    pkg: '@anthropic-ai/claude-code',
    binary: 'claude',
    label: 'Claude Code',
    runtimeId: 'cli:claude-code',
  },
  'gemini-cli': {
    pkg: '@google/gemini-cli',
    binary: 'gemini',
    label: 'Gemini CLI',
    runtimeId: 'cli:gemini-cli',
  },
};

/**
 * What a person still has to do themselves, said plainly rather than implied.
 *
 * **This is the honest gap and it is not closeable from here.** `claude` signs
 * in through `claude auth login`, which opens a browser and needs a terminal on
 * *that* machine; `claude setup-token` is real — checked against an installed
 * 2.1.233 rather than guessed, where it is a documented subcommand reading "Set
 * up a long-lived authentication token (requires Claude subscription)" — and it
 * is equally interactive. The app's terminal pane would be the obvious place to
 * do either and cannot be: the pane is local-only, because the PTY needs a
 * native module that is not deployed to remote hosts (a remote host is two
 * bundled `.js` files with no `node_modules` beside them).
 *
 * So the sentence names the machine and the command, and says where to type it.
 * Pretending an install is the whole job would produce the worse version of the
 * screen this feature exists to fix: no error, and still nothing that runs.
 */
export function authFollowUp(cli: InstallableCli, where: string): string {
  switch (cli) {
    case 'claude-code':
      return (
        `Claude Code is installed on ${where}, and Agbrte cannot sign it in for you: that needs ` +
        `a browser and a terminal on that machine, and this app's terminal pane is local-only ` +
        `for now. Open an ssh session on ${where} and run \`claude auth login\`, or ` +
        `\`claude setup-token\` for a long-lived token if you have a Claude subscription.`
      );
    case 'gemini-cli':
      return (
        `Gemini CLI is installed on ${where}, and signing in is still yours to do. Open an ssh ` +
        `session there and run \`gemini\` once to complete its sign-in, or set GEMINI_API_KEY in ` +
        `the environment the host starts from.`
      );
  }
}

// -------------------------------------------------------------------- ollama

/**
 * Pinned, like `REMOTE_NODE_VERSION` and for the same reason: a machine set up
 * today and one set up next month should be the same machine. Bumped by hand,
 * which is a review rather than a surprise.
 */
export const OLLAMA_VERSION = 'v0.32.14';

/** Where Ollama listens, and the only address it is told to listen on. */
export const OLLAMA_BIND = '127.0.0.1:11434';
/** The endpoint URL a host reaches it at — `/v1`, the OpenAI-compatible shape. */
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

/**
 * The release asset for a platform, or `null` for one we do not ship a path for.
 *
 * `null` rather than a guess: an asset name that does not exist produces a 404
 * inside `curl`, which reaches the user as "the download failed" — a sentence
 * about the network for a problem about the architecture.
 */
export function ollamaAsset(platform: string, arch: string): string | null {
  const os = platform.toLowerCase();
  const cpu =
    arch === 'aarch64' || arch === 'arm64'
      ? 'arm64'
      : arch === 'x86_64' || arch === 'amd64'
        ? 'amd64'
        : null;
  // One tarball for macOS whatever the chip — Ollama ships a universal build.
  if (os === 'darwin') return 'ollama-darwin.tgz';
  if (os !== 'linux' || cpu === null) return null;
  // `.tar.zst` since v0.30. The unpack step checks for a tar that can read it
  // and refuses by name when there is none, rather than failing inside tar.
  return `ollama-linux-${cpu}.tar.zst`;
}

export function ollamaAssetUrl(asset: string, version = OLLAMA_VERSION): string {
  return `https://github.com/ollama/ollama/releases/download/${version}/${asset}`;
}
export function ollamaChecksumUrl(version = OLLAMA_VERSION): string {
  return `https://github.com/ollama/ollama/releases/download/${version}/sha256sum.txt`;
}

// ------------------------------------------------------------------ scripts

/**
 * Free space under `$HOME`, refused up front rather than discovered mid-write.
 *
 * A download that runs out of disk leaves a truncated archive and an error from
 * whichever tool noticed — `tar` complaining about an unexpected end of file is
 * a sentence about the wrong thing. `df -Pk` is POSIX-specified output, so the
 * fourth column is available blocks in KiB on every system this runs on.
 */
function requireSpace(home: string, needKib: number, what: string): string {
  const gb = Math.round((needKib / 1024 / 1024) * 10) / 10;
  /*
   * The path goes through a variable, never into the message directly.
   *
   * Putting `${home}` inside the double-quoted `echo` looked harmless and was
   * the one unquoted use of a remote-supplied value in this file: `$HOME` is
   * whatever that machine says it is, and a `$(…)` inside double quotes is
   * command substitution. Assigning it once from a single-quoted literal and
   * expanding `"$agbrte_home"` afterwards is not re-evaluated, so the rule
   * "no value from the far side reaches a shell unquoted" holds with no
   * exception to remember. Caught by a test asserting exactly that.
   */
  return (
    `agbrte_home=${shellQuote(home)}; ` +
    `free=$(df -Pk "$agbrte_home" 2>/dev/null | awk 'NR==2{print $4}'); ` +
    `if [ -n "$free" ] && [ "$free" -lt ${needKib} ]; then ` +
    `echo "@@fail checking there is room"; ` +
    `echo "not enough free space for ${what}: needs about ${gb} GB, ` +
    `$((free / 1024)) MB free under $agbrte_home" >&2; exit 1; fi`
  );
}

/**
 * Install one CLI with npm, into a private prefix.
 *
 * `PATH` is *prefixed* here rather than appended, which is the opposite of
 * §6.8's rule for a user's own preview command, and deliberately: this is our
 * install, run with the runtime we chose, and `@anthropic-ai/claude-code` has a
 * `postinstall` that runs `node` under an `engines: >=22` constraint. Under an
 * older system Node that postinstall fails, on a machine whose own Node is
 * irrelevant to a package going into our own directory. Nothing the *user* runs
 * is affected; the prefix is thrown away with `~/.agbrte`.
 */
export function cliInstallScript(home: string, npmBin: string, cli: InstallableCli): string {
  const { pkg, binary } = CLI_PACKAGES[cli];
  const root = shellQuote(remoteRoot(home));
  const prefix = shellQuote(managedNpmPrefix(home));
  const nodeDir = shellQuote(`${remoteNodeDir(home)}/bin`);

  return [
    `echo "@@step checking there is room"`,
    // 600 MiB: the package plus its platform-specific optional dependency, with
    // room for npm's cache spike. Small enough not to refuse a modest VM.
    requireSpace(home, 600 * 1024, 'the CLI and its dependencies'),
    `echo "@@step preparing ~/.agbrte"`,
    // 0700 on the root, because a key may end up in `endpoints.json` beside it
    // (§13). `mkdir -p` alone leaves it at the umask, which is 0755 on an
    // ordinary machine — and that was already true before this file existed.
    `mkdir -p ${prefix} && chmod 700 ${root} || { echo "@@fail preparing ~/.agbrte"; exit 1; }`,
    `echo "@@step installing ${pkg}"`,
    `PATH=${nodeDir}:"$PATH" ${shellQuote(npmBin)} install --global --prefix ${prefix} ` +
      `--no-fund --no-audit ${shellQuote(pkg)} || { echo "@@fail installing ${pkg}"; exit 1; }`,
    `echo "@@step checking it runs"`,
    // Its own step: an install that "succeeded" and produced a binary that will
    // not start is the failure the host would otherwise report hours later as
    // "not detected", which is the sentence this whole feature exists to remove.
    `PATH=${nodeDir}:"$PATH" ${shellQuote(`${managedCliBin(home)}/${binary}`)} --version || ` +
      `{ echo "@@fail checking it runs"; exit 1; }`,
    `echo "@@done"`,
  ].join('\n');
}

/**
 * Get an Ollama serving on loopback, doing as little as the machine allows.
 *
 * Three entry points, cheapest first, because "install Ollama" is usually not
 * what is needed: a machine may already be serving one, or may have the binary
 * with nothing running it. Downloading a gigabyte to discover that would be a
 * long way to arrive at a no-op.
 *
 * **`OLLAMA_HOST` is set explicitly to loopback and that is not decoration.**
 * Ollama's default is `127.0.0.1:11434`, but a default is something an
 * environment can already have changed — and the failure mode is a model server
 * answering on every interface of somebody's build box, which is §6.8's
 * "another user's service on 0.0.0.0" with us as the one who put it there.
 */
export function ollamaInstallScript(
  home: string,
  asset: string,
  version = OLLAMA_VERSION,
): string {
  const root = shellQuote(remoteRoot(home));
  const dir = shellQuote(managedOllamaDir(home));
  const log = shellQuote(`${remoteRoot(home)}/ollama.log`);
  const url = ollamaAssetUrl(asset, version);
  const sums = ollamaChecksumUrl(version);
  const quotedAsset = shellQuote(asset);
  const zst = asset.endsWith('.zst');

  const unpack = zst
    ? /*
       * zstd, and refused by name where it is missing.
       *
       * Ollama moved its Linux assets from `.tgz` to `.tar.zst` at v0.30. GNU
       * tar's `--zstd` shells out to the `zstd` binary, so a machine with a
       * modern tar and no zstd fails *inside* tar with a message about a
       * filter — which reads as a corrupt download. Checked first, and the
       * refusal names what to install.
       */
      `  if tar --zstd -tf ${quotedAsset} >/dev/null 2>&1; then ` +
      `tar --zstd -xf ${quotedAsset} -C ${dir} || { echo "@@fail unpacking"; exit 1; }; ` +
      `elif command -v zstd >/dev/null 2>&1; then ` +
      `zstd -dc ${quotedAsset} | tar -xf - -C ${dir} || { echo "@@fail unpacking"; exit 1; }; ` +
      `else echo "@@fail unpacking"; ` +
      `echo "this machine cannot read a .tar.zst archive: its tar has no --zstd and there is no zstd binary. Install zstd and try again." >&2; ` +
      `exit 1; fi`
    : `  tar -xzf ${quotedAsset} -C ${dir} || { echo "@@fail unpacking"; exit 1; }`;

  return [
    `echo "@@step looking for an Ollama already running"`,
    `if curl -fsS --max-time 5 http://${OLLAMA_BIND}/api/version >/dev/null 2>&1; then ` +
      `echo "@@step it is already serving"; echo "@@done"; exit 0; fi`,

    `echo "@@step looking for an installed ollama"`,
    // The managed copy first, then the machine's own — same order and same
    // reason as the Node probe: ours is the version this was tested with, and a
    // system upgrade cannot move it underneath.
    `OLLAMA=""; ` +
      `if [ -x ${dir}/bin/ollama ]; then OLLAMA=${dir}/bin/ollama; ` +
      `elif [ -x ${dir}/ollama ]; then OLLAMA=${dir}/ollama; ` +
      `elif command -v ollama >/dev/null 2>&1; then OLLAMA=$(command -v ollama); fi`,

    `if [ -z "$OLLAMA" ]; then`,
    `  echo "@@step checking there is room"`,
    // ~2.5 GiB: the archive plus what it unpacks to, both under $HOME.
    `  ${requireSpace(home, 2560 * 1024, 'Ollama')}`,
    `  echo "@@step downloading Ollama ${version} (about a gigabyte)"`,
    `  mkdir -p ${dir} && chmod 700 ${root} || { echo "@@fail downloading"; exit 1; }`,
    `  work=$(mktemp -d) || { echo "@@fail downloading"; exit 1; }`,
    `  cd "$work" || { echo "@@fail downloading"; exit 1; }`,
    // `-f` so an HTTP error is a non-zero exit rather than a saved error page,
    // which would then fail confusingly inside tar. `-L` because a release asset
    // is a redirect to object storage.
    `  curl -fsSL ${shellQuote(url)} -o ${quotedAsset} || { echo "@@fail downloading"; exit 1; }`,
    `  curl -fsSL ${shellQuote(sums)} -o sha256sum.txt || { echo "@@fail downloading"; exit 1; }`,

    `  echo "@@step checking the download"`,
    /*
     * Verified before anything is unpacked or run.
     *
     * §6.4 checksums our own bundle before exec, and the reason applies at least
     * as strongly to a gigabyte of somebody else's binary that is about to run
     * as the user. The sums file is published beside the asset, so this proves
     * the bytes are the release's rather than proving the release is
     * trustworthy — but it is exactly the check that catches a truncated
     * download, and a truncated download is what a disk filling up produces.
     */
    `  want=$(awk -v n="./${asset}" '$2==n{print $1}' sha256sum.txt)`,
    `  if [ -z "$want" ]; then echo "@@fail checking the download"; ` +
      `echo "the release does not publish a checksum for ${asset}" >&2; exit 1; fi`,
    `  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum ${quotedAsset} | awk '{print $1}'); ` +
      `elif command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 ${quotedAsset} | awk '{print $1}'); ` +
      `else echo "@@fail checking the download"; ` +
      `echo "this machine has neither sha256sum nor shasum, so the download cannot be checked" >&2; exit 1; fi`,
    `  if [ "$want" != "$got" ]; then echo "@@fail checking the download"; ` +
      `echo "the downloaded ${asset} does not match the checksum the release publishes" >&2; exit 1; fi`,

    `  echo "@@step unpacking"`,
    unpack,
    `  rm -f ${quotedAsset} sha256sum.txt`,
    // Found rather than assumed: the Linux tarball lays out `bin/ollama` and the
    // macOS one puts the binary at the root, and hardcoding either would break
    // the other on a layout change nobody here would see.
    `  OLLAMA=$(find ${dir} -maxdepth 3 -type f -name ollama -perm -u+x 2>/dev/null | head -1)`,
    `  if [ -z "$OLLAMA" ]; then echo "@@fail unpacking"; ` +
      `echo "unpacked ${asset} but found no ollama binary inside it" >&2; exit 1; fi`,
    `fi`,

    `echo "@@step starting the server"`,
    /*
     * Detached exactly as the host is (§6.4).
     *
     * `setsid` puts it in its own session so a group signal cannot reach it,
     * `nohup` covers the SIGHUP that arrives first, and the subshell's fds are
     * redirected because `ssh` does not return while anything still holds the
     * channel's stdout — the same afternoon's lesson `startRemoteHost` records.
     */
    `( OLLAMA_HOST=${OLLAMA_BIND} nohup setsid "$OLLAMA" serve >${log} 2>&1 < /dev/null & ) >/dev/null 2>&1`,
    `echo "@@step waiting for it to answer"`,
    // Readiness is the API answering, not the process existing — the same
    // distinction `startRemoteHost` draws between "launched" and "listening".
    `for i in $(seq 1 60); do ` +
      `if curl -fsS --max-time 2 http://${OLLAMA_BIND}/api/version >/dev/null 2>&1; then ` +
      `echo "@@done"; exit 0; fi; sleep 1; done`,
    `echo "@@fail waiting for it to answer"; ` +
      `echo "ollama serve was started but never answered on ${OLLAMA_BIND}" >&2; ` +
      `tail -20 ${log} >&2 2>/dev/null; exit 1`,
  ].join('\n');
}

// -------------------------------------------------------------------- runner

/**
 * Read `@@step` / `@@fail` markers out of a stream as they arrive.
 *
 * Whole lines only, torn tail retained — the same rule §6.6 states for the log
 * tail, and for the same reason: a chunk boundary lands inside a line often
 * enough that parsing per chunk would drop or duplicate a step.
 */
export class StepReader {
  private partial = '';
  private lastStep = '';
  private failedAt: string | null = null;

  constructor(private readonly onStep: (step: string) => void) {}

  push(chunk: string): void {
    this.partial += chunk;
    const lines = this.partial.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  /** Flush a final line that arrived with no trailing newline. */
  end(): void {
    if (this.partial !== '') {
      this.line(this.partial);
      this.partial = '';
    }
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (line.startsWith('@@step ')) {
      this.lastStep = line.slice('@@step '.length);
      this.onStep(this.lastStep);
      return;
    }
    if (line.startsWith('@@fail')) {
      this.failedAt = line.slice('@@fail'.length).trim() || this.lastStep;
    }
  }

  /** The step that printed `@@fail`, else the last one announced. */
  get failure(): string {
    return this.failedAt ?? this.lastStep;
  }
}

/**
 * Run one route against one machine.
 *
 * `alias` is the ssh name, or ignored entirely by a local runner — the same
 * shape either way, which is what keeps the local and remote behaviour from
 * diverging. Everything transport-specific was decided by whoever built the
 * runner.
 */
export async function runSetup(
  runner: ProvisionRunner,
  /**
   * The machine, in the user's words — an ssh alias, or `this machine`.
   *
   * One parameter for two jobs, which is exact rather than lazy: it is what the
   * runner is given to dial (a local runner ignores it) *and* what every refusal
   * names. Two would let a message name a machine other than the one the command
   * went to, which is the failure `diagnoseSshFailure` records as worse than no
   * message at all.
   */
  where: string,
  probe: RemoteProbe,
  plan: SetupPlan,
  onStep: (step: string) => void,
): Promise<void> {
  if (plan.kind === 'endpoint') {
    // An assertion rather than a comment: a credential travels to the host over
    // the session channel and is written there with `fs`. Nothing about it goes
    // near `sh`, and a caller that routed it here would be the bug.
    throw new RouteRefused(
      'an API endpoint is written by the host, not installed over ssh — this is a bug in the caller',
    );
  }

  const platform = probe.platform.toLowerCase();
  if (platform !== 'linux' && platform !== 'darwin') {
    /*
     * Refused by name, and the divergence is deliberate (§6.2's Windows
     * discovery refusal sets the precedent).
     *
     * Attaching a Windows machine works — there is a whole PowerShell bootstrap
     * for it. Setting one up does not, because every script above is `sh`, npm's
     * `--prefix` layout differs there (`<prefix>` rather than `<prefix>/bin`),
     * Ollama's Windows asset is an installer rather than a tarball, and none of
     * it could be checked against a real Windows remote here. An unverified
     * script that half-installs something is worse than a sentence saying "not
     * here": the first leaves a machine in a state nobody can describe.
     */
    throw new RouteRefused(
      `${where} does not run Linux or macOS, so Agbrte cannot install ${
        plan.kind === 'cli' ? CLI_PACKAGES[plan.cli].label : 'Ollama'
      } there. Attaching such a machine works; setting one up does not — install it yourself ` +
        `and restart this host. Adding an API endpoint works on any machine.`,
    );
  }

  const script =
    plan.kind === 'cli'
      ? cliInstallScript(probe.home, await npmFor(runner, where, probe, onStep), plan.cli)
      : ollamaScriptFor(where, probe);

  const reader = new StepReader(onStep);
  const result = await runner.exec(where, script, { onData: (chunk) => reader.push(chunk) });
  reader.end();

  if (result.code !== 0) {
    throw new SetupFailed(
      reader.failure,
      `could not ${describePlan(plan)} on ${where}${
        reader.failure === '' ? '' : ` — it failed while ${reader.failure}`
      }`,
      // Verbatim, first lines first: this is `curl`, `npm` and `tar` talking
      // about a machine the reader cannot see, and paraphrasing them has never
      // once helped.
      firstLines(result.stderr, 6),
    );
  }
}

function ollamaScriptFor(where: string, probe: RemoteProbe): string {
  const asset = ollamaAsset(probe.platform, probe.arch);
  if (asset === null) {
    throw new RouteRefused(
      `Ollama publishes no build for ${probe.platform}/${probe.arch}, which is what ${where} ` +
        `reports. Point this host at a model server elsewhere instead — ` +
        `"Add an API endpoint" takes any OpenAI-compatible base URL.`,
    );
  }
  return ollamaInstallScript(probe.home, asset);
}

/**
 * The npm to install with, installing our Node first if there is none.
 *
 * `installRemoteNode` rather than a second downloader: §6.4's bootstrap already
 * knows the tarball URL, the strip-components layout and the failure message,
 * and a machine that has been attached usually has it unpacked already.
 *
 * A system npm is used where one sits beside the system node, so a machine with
 * its own toolchain is not made to download 50 MB it already has. The prefix
 * makes that safe: whichever npm runs, it writes only into `~/.agbrte/npm`.
 */
async function npmFor(
  runner: ProvisionRunner,
  alias: string,
  probe: RemoteProbe,
  onStep: (step: string) => void,
): Promise<string> {
  const managed = `${remoteNodeDir(probe.home)}/bin/npm`;
  const beside = probe.nodePath === null ? null : `${probe.nodePath.replace(/\/[^/]*$/, '')}/npm`;

  onStep('looking for npm on that machine');
  const found = await runner.exec(
    alias,
    `if [ -x ${shellQuote(managed)} ]; then echo ${shellQuote(managed)}; ` +
      (beside === null
        ? ''
        : `elif [ -x ${shellQuote(beside)} ]; then echo ${shellQuote(beside)}; `) +
      `else echo; fi`,
  );
  const path = found.stdout.trim();
  if (found.code === 0 && path !== '') return path;

  onStep('installing a private Node runtime (nothing system-wide)');
  // The bootstrap's own installer, unchanged. It ends by running the binary it
  // unpacked, so reaching the next line means the layout is the one below.
  await installRemoteNode(runner, alias, probe);
  return managed;
}

/** Enough of a tool's complaint to act on, without pasting a whole build log. */
function firstLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, count)
    .join('\n')
    .trim();
}
