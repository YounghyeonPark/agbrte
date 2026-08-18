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
        const child = spawn('/bin/sh', ['-c', command], {
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
      }),
  };
}
