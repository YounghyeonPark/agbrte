/**
 * The same runner interface, pointed at this machine (DESIGN.md §6.2).
 *
 * `provision.ts` sets a machine up through `ProvisionRunner.exec`, and a local
 * host is a machine too — the one under the keyboard. Giving it its own runner
 * rather than a second code path is the point: every refusal, every step marker,
 * every quoting rule and every parse is then shared, so "install Claude Code"
 * cannot mean one thing locally and another over ssh. §6.4 already argues this
 * for the host itself ("one binary, two deployments, so the local path
 * continuously exercises the remote code path"); the same argument holds for the
 * thing that installs what the host runs.
 *
 * **Windows is refused here rather than deeper down.** The scripts are `sh`, and
 * a Windows machine has none — the same refusal `runSetup` makes for a Windows
 * remote, made one layer earlier because `probeLocal` cannot even answer
 * `uname`. Saying it here keeps the sentence about *this* machine rather than
 * about a probe that failed.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { arch, platform } from 'node:process';
import type { RemoteProbe } from './sshTransport.js';
import { RouteRefused, type ProvisionRunner } from './provision.js';

/**
 * What the remote probe would have reported, for the machine we are on.
 *
 * Built rather than executed: `uname` exists here too, but running it would be
 * asking a subprocess something Node already knows, and the mapping is exactly
 * the one `nodeTarballUrl` and `ollamaAsset` consume.
 *
 * `nodePath` is `process.execPath`, which for a packaged app is Electron rather
 * than Node — that is *correct* for the one thing it is used for. `npmFor` looks
 * for an `npm` beside it and finds none, so the private Node is installed and
 * used, which is the right answer for a machine whose only "Node" is an Electron
 * binary that would refuse to run npm.
 */
export function probeLocal(): RemoteProbe {
  return {
    reachable: true,
    arch: arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch,
    platform: platform === 'darwin' ? 'Darwin' : platform === 'linux' ? 'Linux' : platform,
    nodePath: process.execPath,
    bundleVersion: null,
    home: homedir(),
    detail: '',
  };
}

/**
 * This machine's platform, spelled the way a remote probe spells it.
 *
 * `probeLocal` reports `win32` unchanged, because the two consumers it was
 * written for — `nodeTarballUrl` and `ollamaAsset` — never see a Windows machine
 * and `runSetup` refuses one by not matching `linux` or `darwin` either way.
 * `serverReadiness` is the first caller for which Windows is a *branch* rather
 * than a refusal, and it has two callers of its own. One function, so the
 * spelling cannot drift between them and hand a Windows box the Linux answer.
 */
export function localPlatform(): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Darwin' : 'Linux';
}

/**
 * Run a shell command on this machine, with the same shape `ssh` has.
 *
 * `sh -c` and not `shell: true`: on Windows the latter would be `cmd.exe`, which
 * would take a POSIX script and print parts of it back while exiting 0 — the
 * exact failure §6.2 records from the first Windows probe, reproduced locally.
 * The refusal above means it is never reached, and the explicit binary means it
 * could not silently start working the wrong way if it were.
 */
export function localRunner(): ProvisionRunner {
  return {
    exec: (_alias, command, opts) =>
      new Promise((resolve) => {
        if (platform === 'win32') {
          throw new RouteRefused(
            'this machine runs Windows, and Agbrte sets a machine up through a POSIX shell. ' +
              'Install the CLI or Ollama yourself and restart this host — adding an API ' +
              'endpoint works here.',
          );
        }
        resolve(shellOut('/bin/sh', ['-c', command], opts));
      }),
  };
}

/**
 * The same runner, for asking rather than for installing — and it works on
 * Windows, where `localRunner` refuses.
 *
 * The refusal above is right and stays: `runSetup`'s scripts are `sh`, and
 * `cmd.exe` given one prints parts of it back while exiting 0, which is the
 * failure §6.2 records from the first Windows probe. But `serverReadiness` sends
 * no scripts. It sends `nvidia-smi`, `wsl --status` and `docker info` — programs
 * that exist on Windows, are already platform-branched by their caller, and
 * change nothing on the machine.
 *
 * Refusing them cost a measurement to notice: `probeMachine` on this Windows
 * machine reported no GPU, on a box with an RTX 4090 in it, because every
 * command came back refused and "could not ask" was rendered as "there is none".
 * §3.3 spends three confidence tiers on exactly that, and the remedy has two
 * halves — this runner, so the question can be asked at all, and the rethrow in
 * `probeMachine`, so a machine that still cannot answer says so.
 *
 * **Reads only.** Nothing here should be handed a command that changes the
 * machine; that path is `localRunner` and it is refused on Windows on purpose.
 */
export function localProbeRunner(): ProvisionRunner {
  return {
    exec: (_alias, command, opts) =>
      platform === 'win32'
        ? // `/d` skips AutoRun, which is somebody's `cd` in the registry and
          // would otherwise prepend output to every answer parsed here.
          shellOut(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', command], opts)
        : shellOut('/bin/sh', ['-c', command], opts),
  };
}

/**
 * Spawn, collect, and honour the timeout — shared so the two runners above
 * cannot drift apart in how they report a failure.
 *
 * Never rejects: a command that could not start is `code: 127` with the reason
 * in `stderr`, and a command cut short is `code: 124` with whatever had already
 * arrived, which is the contract `systemSshRunner` documents.
 */
function shellOut(
  bin: string,
  args: string[],
  opts: Parameters<ProvisionRunner['exec']>[2],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let cutShort = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
      opts?.onData?.(d);
    });
    child.stderr.on('data', (d: string) => (stderr += d));
    // The same contract `systemSshRunner` documents: code 124 means cut
    // short, and whatever had already arrived is still returned.
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
}
