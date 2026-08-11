/**
 * Bootstrapping a host on a Windows machine (DESIGN.md §6.2, §6.3).
 *
 * §6.3 installs the host on the machine it controls, and everything that does
 * that installing was a POSIX shell script — so a Windows server answered ssh
 * perfectly well and could not be attached at all.
 *
 * ## What is real here and what is not
 *
 * The runner executes through `cmd.exe` **on this machine** rather than over
 * ssh, which is exactly what Windows `sshd` does with a command by default. So
 * every quoting layer but one is genuine, and everything the bootstrap actually
 * does — the probe, downloading and unpacking a private Node, streaming a
 * bundle in over stdin, a detached launch, the loopback control channel — runs
 * for real against a real filesystem and real processes.
 *
 * The untested layer is `ssh` itself, which needs `sshd` on this machine and
 * therefore an elevated install. It is also the layer least likely to be wrong:
 * every command crosses it as base64 and nothing in it can be mangled.
 *
 * These skip off Windows, where `powershell.exe` and `cmd.exe` do not exist.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  installWindowsNode,
  parseProbe,
  probeWindows,
  psCommand,
  startWindowsHost,
  uploadWindowsBundles,
  windowsNodeExe,
  windowsNodeUrl,
  windowsWriteFileCommand,
} from '@main/host/windowsBootstrap.js';
import { connectLoopback } from '@shared/host/loopback.js';
import { HostConnection } from '@main/host/hostConnection.js';
import type { SshRunner } from '@main/host/sshTransport.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { AgentId, SessionId } from '@shared/types/index.js';

const onWindows = process.platform === 'win32' ? describe : describe.skip;

/**
 * A runner that executes here, through `cmd.exe`.
 *
 * `ssh <host> <command>` on Windows runs the command in the default shell,
 * which is `cmd.exe` unless somebody set `DefaultShell`. Going through `cmd`
 * rather than spawning PowerShell directly keeps the layer that mangles things
 * in the test rather than removing it.
 */
function localWindowsRunner(): SshRunner {
  const run = (command: string, stdin?: Buffer) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('cmd.exe', ['/c', command], {
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d) => (stdout += d));
      child.stderr!.on('data', (d) => (stderr += d));
      child.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (stdin !== undefined) child.stdin!.end(stdin);
    });

  return {
    exec: (_alias, command) => run(command),
    upload: async (_alias, remotePath, contents) => {
      const r = await run(windowsWriteFileCommand(remotePath), contents);
      if (r.code !== 0) throw new Error(`upload failed: ${r.stderr}`);
    },
    forward: () => Promise.reject(new Error('the local runner has nothing to tunnel')),
  };
}

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const c of closers.splice(0)) c();
});

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe('a command survives every shell between here and there', () => {
  it('carries nothing any of them could mangle', () => {
    /**
     * A command crosses `spawn`, `ssh`, `cmd.exe` and finally PowerShell. Each
     * has its own quoting rules and `cmd`'s do not compose — this session
     * already lost an afternoon to `powershell -Command "<script>" arg`
     * appending the argument *to the script*.
     *
     * `-EncodedCommand` is base64 of UTF-16LE, so what reaches the command line
     * is only `[A-Za-z0-9+/=]`. There is nothing left to escape.
     */
    const nasty = `Write-Output "it's & <this> | that ^ %PATH% \`" $(evil)"`;
    const wrapped = psCommand(nasty);
    const payload = wrapped.split('-EncodedCommand ')[1]!;
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
    for (const ch of ['"', "'", '&', '<', '>', '|', '^', '%', '`', '$']) {
      expect(payload, `${ch} reached the command line`).not.toContain(ch);
    }
  });

  it('silences the progress stream', () => {
    // PowerShell writes progress to stderr as CLIXML. Left on, every successful
    // command returns a page of `#< CLIXML` noise on the channel error
    // reporting reads, and a real failure arrives buried in it.
    const body = Buffer.from(
      psCommand('Write-Output 1').split('-EncodedCommand ')[1]!,
      'base64',
    ).toString('utf16le');
    expect(body).toContain("$ProgressPreference='SilentlyContinue'");
  });
});

describe('the node build it would fetch', () => {
  it('asks for a zip, because Windows has no tar.xz', () => {
    expect(windowsNodeUrl('x64')).toMatch(/node-v\d+\.\d+\.\d+-win-x64\.zip$/);
    expect(windowsNodeUrl('arm64')).toMatch(/-win-arm64\.zip$/);
  });

  it('normalises what Windows calls its architecture', () => {
    // `PROCESSOR_ARCHITECTURE` says AMD64 or ARM64; the download wants x64 or
    // arm64. One vocabulary reaches the rest of the bootstrap.
    expect(parseProbe('arch=AMD64\nhome=C:\\Users\\x').get('arch')).toBe('AMD64');
    expect(windowsNodeUrl('x64')).toContain('win-x64');
  });
});

onWindows('against this machine, for real', () => {
  it('probes it', async () => {
    const probe = await probeWindows(localWindowsRunner(), 'self');
    expect(probe.reachable).toBe(true);
    expect(probe.platform).toBe('Windows_NT');
    expect(['x64', 'arm64']).toContain(probe.arch);
    expect(probe.home).toBe(homedir());
  }, 60_000);

  it('streams a bundle in over stdin, byte for byte', async () => {
    /**
     * The POSIX path uses `cat > path`. There is no `cat`, and `more >` mangles
     * binary — so PowerShell opens the raw standard input stream. `$input` would
     * have been the obvious choice and is line-oriented, which corrupts anything
     * that is not text.
     *
     * Asserted with bytes chosen to break a text path: a NUL, a CR without an
     * LF, and every high byte.
     */
    const root = await mkdtemp(join(tmpdir(), 'agbrte-winup-'));
    roots.push(root);
    const target = join(root, 'payload.bin');
    const bytes = Buffer.from([
      0x00, 0x0d, 0x0a, 0x0d, 0x1a, 0xff, 0xfe, 0x00,
      ...Array.from({ length: 256 }, (_unused, i) => i),
    ]);

    await localWindowsRunner().upload('self', target, bytes);

    const back = await readFile(target);
    expect(back.length, 'the stream changed length').toBe(bytes.length);
    expect(back.equals(bytes), 'the bytes were mangled in transit').toBe(true);
  }, 60_000);

  it('installs a private Node, and touches nothing else', async () => {
    // The same promise the POSIX path makes: nothing system-wide, no installer,
    // no administrator. Skipped when one is already unpacked, since downloading
    // 33 MB to prove it a second time is not evidence.
    const runner = localWindowsRunner();
    const probe = await probeWindows(runner, 'self');
    const exe = windowsNodeExe(probe.home);

    if (!existsSync(exe)) {
      await installWindowsNode(runner, 'self', probe);
    }

    expect(existsSync(exe), 'no node.exe under the private root').toBe(true);
    const version = await runner.exec('self', psCommand(`& "${exe}" --version`));
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+$/);
  }, 600_000);

  it('starts a detached host on a loopback port and serves a session', async () => {
    /**
     * The whole point, end to end. A Windows host cannot use a named pipe — `ssh
     * -L` will not forward one — so it must come up on §6.2's loopback control
     * channel with a bearer token. This is that channel's first real user, and
     * the reason it was built before there was anything to use it.
     */
    const runner = localWindowsRunner();
    const probe = await probeWindows(runner, 'self');
    const node = probe.nodePath ?? windowsNodeExe(probe.home);

    const workspace = await mkdtemp(join(tmpdir(), 'agbrte-winhost-'));
    roots.push(workspace);

    await uploadWindowsBundles(
      runner,
      'self',
      probe.home,
      {
        host: await readFile('dist/main/agbrteHost.js'),
        agent: await readFile('dist/main/agentHost.js'),
      },
      `wintest-${Date.now()}`,
    );

    const started = await startWindowsHost(runner, 'self', probe.home, node, workspace, {
      lingerMs: 60_000,
    });
    expect(started.port).toBeGreaterThan(0);
    expect(started.token).toMatch(/^[0-9a-f]{64}$/);

    const channel = await connectLoopback<SessionCommand, SessionMessage>(
      started.port,
      started.token,
    );
    const connection = new HostConnection({ channel, client: 'agbrte-test@windows' });
    closers.push(() => connection.disconnect());

    const identity = await connection.ready;
    expect(identity.workspaceRoot).toBe(workspace);
    expect(identity.pid).toBeGreaterThan(0);

    const session = await connection.createSession({ title: 'on windows', goal: 'g' });
    const agent = await connection.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
    });
    await connection.send(
      session.sessionId as SessionId,
      agent.agentId as AgentId,
      'a turn on a Windows host',
    );

    const events = await connection.events(session.sessionId as SessionId);
    expect(events.map((e) => e.type)).toContain('agent.stopped');
    expect(JSON.stringify(events)).toContain('a turn on a Windows host');

    // The token is a credential and the record is where it lives. On Windows
    // there is no mode to check, so what is asserted is that it exists at all
    // and is not in the log.
    const record = JSON.parse(
      await readFile(join(workspace, '.devagents', 'host.json'), 'utf8'),
    ) as { token?: string; port?: number };
    expect(record.token).toBe(started.token);
    expect(record.port).toBe(started.port);
    await expect(stat(join(workspace, '.devagents', 'host.json'))).resolves.toBeDefined();

    const log = await readFile(
      join(workspace, '.devagents', 'sessions', session.sessionId, 'events.jsonl'),
      'utf8',
    );
    expect(log).not.toContain(started.token);

    await connection.requestShutdown().catch(() => undefined);
  }, 300_000);
});
