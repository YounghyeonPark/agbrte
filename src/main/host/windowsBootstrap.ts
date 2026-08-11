/**
 * Bootstrapping a session host on a **Windows** machine (DESIGN.md §6.2, §6.3).
 *
 * §6.3 puts the loop on the remote, so the host is installed on the machine it
 * controls — and everything in `sshTransport.ts` that does that installing is a
 * POSIX shell script: `uname`, `command -v`, `nohup setsid`, `cat >`, a
 * `.tar.xz`, and a unix socket. A Windows server answers ssh perfectly well and
 * could not be attached at all.
 *
 * This is the second bootstrap. It reuses the transport, the protocol, the
 * store, and §6.2's loopback control channel; what it replaces is the five
 * places that assumed a POSIX shell.
 *
 * ## Every command is base64, and that is the whole trick
 *
 * A command here crosses four layers before it runs: `spawn` on this machine,
 * `ssh`, the remote's default shell — `cmd.exe` unless somebody changed it —
 * and finally PowerShell. Each has its own quoting rules and `cmd.exe`'s are
 * notoriously not composable. This session has already lost an afternoon to one
 * such layer, where `powershell -Command "<script>" arg` appended the argument
 * *to the script* instead of binding it.
 *
 * `-EncodedCommand` takes base64 of UTF-16LE, so the command line contains only
 * `[A-Za-z0-9+/=]`. There is nothing left for any of those four layers to
 * mangle — no quotes, no ampersands, no percent signs, no carets. Verified
 * against real PowerShell before anything was built on it.
 *
 * ## `$ProgressPreference` is not cosmetic
 *
 * PowerShell writes progress records to stderr as CLIXML — `#< CLIXML` followed
 * by a wall of XML. Left on, every successful command returns a page of noise on
 * the channel that error reporting reads, and a real failure arrives buried in
 * it. Silenced at the top of every script.
 */

import type { RemoteProbe, SshRunner } from './sshTransport.js';
import { RemoteBootstrapFailed, REMOTE_NODE_VERSION } from './sshTransport.js';

/** Where Agbrte lives in a Windows profile. Mirrors `~/.agbrte` on POSIX. */
export function windowsRoot(home: string): string {
  return `${home}\\.agbrte`;
}
export function windowsNodeExe(home: string): string {
  return `${windowsRoot(home)}\\node\\node.exe`;
}
export function windowsBundle(home: string): string {
  return `${windowsRoot(home)}\\agbrteHost.js`;
}
export function windowsAgentBundle(home: string): string {
  return `${windowsRoot(home)}\\agentHost.js`;
}

/**
 * Wrap a PowerShell script so it survives every shell between here and there.
 *
 * `-NonInteractive` because there is no one to answer a prompt, and a prompt on
 * a detached channel is a hang rather than a question.
 */
export function psCommand(script: string): string {
  /**
   * Full-line comments are stripped before encoding, and that is not tidiness.
   *
   * Base64 of UTF-16LE is **2.67x** the source, and `cmd.exe` caps a command
   * line at 8191 characters. Explaining the WMI launch properly added about six
   * hundred characters of comment to the script, which became sixteen hundred on
   * the wire, and the whole thing came back as `The command line is too long.` —
   * an error about a limit, from a change that added no code.
   *
   * So the reasoning stays in the source where it is worth having and never
   * leaves this machine. What crosses is the script.
   */
  const stripped = script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => line.trim() !== '')
    .join('\n');

  const body = `$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';${stripped}`;
  const encoded = Buffer.from(body, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/**
 * One round trip that answers everything the bootstrap decides on.
 *
 * Same shape and same reasoning as the POSIX probe: each `ssh` invocation is a
 * full connection setup, and five sequential probes is five of them.
 */
export const WINDOWS_PROBE = `
$root = "$env:USERPROFILE\\.agbrte"
Write-Output "home=$env:USERPROFILE"
Write-Output "arch=$env:PROCESSOR_ARCHITECTURE"
Write-Output "platform=Windows_NT"
if (Test-Path "$root\\node\\node.exe") { Write-Output "node=$root\\node\\node.exe" }
elseif (Get-Command node -ErrorAction SilentlyContinue) { Write-Output "node=$((Get-Command node).Source)" }
else { Write-Output "node=" }
if (Test-Path "$root\\agbrteHost.js") {
  $first = Get-Content "$root\\agbrteHost.js" -First 1
  if ($first -match '^// agbrte-bundle: (.*)$') { Write-Output "bundle=$($Matches[1])" } else { Write-Output "bundle=" }
} else { Write-Output "bundle=" }
`.trim();

/** Read the probe's `key=value` lines. Shared shape with the POSIX one. */
export function parseProbe(stdout: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return fields;
}

export async function probeWindows(runner: SshRunner, alias: string): Promise<RemoteProbe> {
  const result = await runner.exec(alias, psCommand(WINDOWS_PROBE));
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

  const f = parseProbe(result.stdout);
  const node = f.get('node') ?? '';
  const bundle = f.get('bundle') ?? '';
  return {
    reachable: true,
    // `PROCESSOR_ARCHITECTURE` says `AMD64` or `ARM64`, which is not what the
    // download URL wants. Normalised here so one vocabulary reaches the rest.
    arch: (f.get('arch') ?? '').toUpperCase() === 'ARM64' ? 'arm64' : 'x64',
    platform: 'Windows_NT',
    nodePath: node === '' ? null : node,
    bundleVersion: bundle === '' ? null : bundle,
    home: f.get('home') ?? '',
    detail: result.stdout.trim(),
  };
}

/** Node's own Windows build. A `.zip`, which PowerShell can unpack unaided. */
export function windowsNodeUrl(arch: string, version = REMOTE_NODE_VERSION): string {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  return `https://nodejs.org/dist/${version}/node-${version}-win-${cpu}.zip`;
}

/**
 * Put a private Node under `%USERPROFILE%\.agbrte\node`, touching nothing else.
 *
 * The same promise the POSIX path makes: nothing system-wide, no installer, no
 * administrator. A machine you were lent should not need changing to be used.
 *
 * `Expand-Archive` has no `--strip-components`, so the versioned directory the
 * zip contains is moved up by hand — the caller should not have to know which
 * build is unpacked, and an upgrade should replace the directory rather than add
 * a second one to choose between.
 */
export async function installWindowsNode(
  runner: SshRunner,
  alias: string,
  probe: RemoteProbe,
): Promise<void> {
  const url = windowsNodeUrl(probe.arch);
  const script = `
$root = "$env:USERPROFILE\\.agbrte"
New-Item -ItemType Directory -Force -Path $root | Out-Null
$zip = Join-Path $env:TEMP "agbrte-node.zip"
$stage = Join-Path $env:TEMP "agbrte-node-stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
# TLS 1.2 explicitly: Windows PowerShell 5.1 still negotiates SSL3/TLS1.0 by
# default on older images, and nodejs.org refuses those.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri "${url}" -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $stage -Force
$inner = Get-ChildItem $stage -Directory | Select-Object -First 1
if (Test-Path "$root\\node") { Remove-Item -Recurse -Force "$root\\node" }
Move-Item $inner.FullName "$root\\node"
Remove-Item -Force $zip
Remove-Item -Recurse -Force $stage
& "$root\\node\\node.exe" --version
`.trim();

  const result = await runner.exec(alias, psCommand(script));
  if (result.code !== 0) {
    throw new RemoteBootstrapFailed('could not install Node on the Windows remote', result.stderr.trim());
  }
}

/**
 * Copy a bundle by streaming it into the command's stdin.
 *
 * The POSIX path uses `cat > path`. There is no `cat`, and `more >` mangles
 * binary — so PowerShell opens the raw standard input stream and copies it. The
 * .NET stream is used rather than `$input` because `$input` is a line-oriented
 * pipeline and would corrupt anything that is not text.
 */
export function windowsWriteFileCommand(remotePath: string): string {
  return psCommand(`
$out = [IO.File]::Open("${remotePath}", [IO.FileMode]::Create, [IO.FileAccess]::Write)
$in = [Console]::OpenStandardInput()
$in.CopyTo($out)
$out.Close()
`.trim());
}

export async function uploadWindowsBundles(
  runner: SshRunner,
  alias: string,
  home: string,
  bundles: { host: Buffer; agent: Buffer },
  version: string,
): Promise<void> {
  const stamped = Buffer.concat([Buffer.from(`// agbrte-bundle: ${version}\r\n`), bundles.host]);

  await runner.exec(
    alias,
    psCommand(`New-Item -ItemType Directory -Force -Path "${windowsRoot(home)}" | Out-Null`),
  );
  await runner.upload(alias, windowsAgentBundle(home), bundles.agent);
  // The session host is written last: the probe reads its stamp as "both are
  // deployed", so writing it first would make a half-deployment look complete.
  await runner.upload(alias, windowsBundle(home), stamped);
}

/**
 * Start the host detached, and wait — on the remote — until it is listening.
 *
 * Two things differ from POSIX and both are the platform's, not a preference.
 *
 * `Start-Process` is the detachment: there is no `setsid`, and a child started
 * any other way through an ssh session dies with the session. `-WindowStyle
 * Hidden` because a server has no desk to put a window on.
 *
 * And the control channel is **loopback TCP with a bearer token** rather than a
 * socket: a Windows host would otherwise listen on a named pipe, and `ssh -L`
 * cannot forward one. §6.2 anticipated exactly this and the channel already
 * exists — this is its first real user.
 */
export async function startWindowsHost(
  runner: SshRunner,
  alias: string,
  home: string,
  nodePath: string,
  workspaceRoot: string,
  opts: { lingerMs?: number; readyTimeoutMs?: number } = {},
): Promise<{ pid: number; port: number; token: string; protocol: number; instanceId: string }> {
  const attempts = Math.max(1, Math.ceil((opts.readyTimeoutMs ?? 30_000) / 500));
  // Set inside the command rather than in this shell: WMI starts the process
  // from the service and does not inherit our environment. No space before the
  // `&&`, or `set` keeps it as part of the value.
  const lingerCmd =
    opts.lingerMs === undefined ? '' : `set AGBRTE_HOST_LINGER_MS=${opts.lingerMs}&&`;

  const script = `
$ws = "${workspaceRoot}"
$record = Join-Path $ws ".devagents\\host.json"
New-Item -ItemType Directory -Force -Path $ws | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ws ".devagents") | Out-Null
# The log lives in the **workspace**, not in the profile.
#
# It was one shared path for every host on the machine, so a second host could
# not truncate it while a first still held it open, and reading it told you
# about somebody else's run. A host is per workspace and so is everything it
# writes.
#
# Both streams are truncated, not just one. A failure before launch must not be
# able to show the previous run's output — a stale "listening" line under a
# startup failure says the thing that just failed worked, and the error stream
# had exactly that bug while the output stream did not, which is how a port from
# an earlier run ended up in a diagnosis.
$log = Join-Path $ws ".devagents\\host.log"
Set-Content -Path $log -Value "" -NoNewline
Set-Content -Path "$log.err" -Value "" -NoNewline
# Started through WMI rather than Start-Process, and that IS the detachment.
#
# Start-Process creates a child of this PowerShell, and on Windows a child
# inherits its parent job object. Anything that put the ssh session into a job
# with KILL_ON_JOB_CLOSE -- a test harness, a CI agent, several service wrappers
# -- takes the host down the moment that session ends. Section 6.4 says detached
# means detached, and on Windows Start-Process does not mean it.
#
# Measured rather than assumed: the identical launch keeps the host alive for as
# long as you care to watch when PowerShell runs from a terminal, and the host is
# gone within a second when the same PowerShell is a descendant of a tree that
# owns a job. Win32_Process.Create is carried out by the WMI service, so the new
# process is its child and belongs to no job of ours.
#
# The cost is that WMI does not inherit this process environment, so the
# variables are set inside the command -- which is why this goes through cmd /c
# rather than straight to node.
#
# (No backticks anywhere in these comments: this whole script is a JavaScript
# template literal, and a backtick would end it. That has now cost two files.)
$exe = "${nodePath}"
$bundle = "${windowsBundle(home)}"
$inner = '"' + $exe + '" "' + $bundle + '" "' + $ws + '" > "' + $log + '" 2> "' + $log + '.err"'
$launch = 'cmd.exe /c set AGBRTE_HOST_CONTROL=loopback&&${lingerCmd}' + $inner
$spawned = ([wmiclass]'root\\cimv2:Win32_Process').Create($launch, $ws, $null)
if ($spawned.ReturnValue -ne 0) { Write-Error "Win32_Process.Create returned $($spawned.ReturnValue)"; exit 1 }
# The record is written only once the port is accepting, so waiting for it is
# waiting for readiness rather than for the process to exist.
for ($i = 0; $i -lt ${attempts}; $i++) {
  if ((Test-Path $record) -and (Get-Item $record).Length -gt 0) {
    Get-Content $record -Raw
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
Write-Error "TIMEOUT"
exit 1
`.trim();

  const started = await runner.exec(alias, psCommand(script));
  if (started.code !== 0) {
    throw new RemoteBootstrapFailed(
      'the Windows host never started listening',
      started.stderr.trim(),
    );
  }

  let record: { pid?: number; port?: number; token?: string; protocol?: number; instanceId?: string };
  try {
    record = JSON.parse(started.stdout) as typeof record;
  } catch {
    throw new RemoteBootstrapFailed(
      'the Windows host wrote an unreadable record',
      started.stdout.trim(),
    );
  }

  if (record.port === undefined || record.token === undefined) {
    // A Windows host that came up on a named pipe cannot be forwarded, so this
    // is a wrong build rather than a transient failure — and saying which saves
    // somebody looking at the network.
    throw new RemoteBootstrapFailed(
      'the Windows host is listening on a pipe rather than a loopback port',
      'it was started without AGBRTE_HOST_CONTROL=loopback',
    );
  }

  return {
    pid: record.pid ?? 0,
    port: record.port,
    token: record.token,
    protocol: record.protocol ?? 0,
    instanceId: record.instanceId ?? '',
  };
}
