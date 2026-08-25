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
 * does — the probe, downloading and unpacking a private Node, a detached
 * launch, the loopback control channel — runs for real against a real
 * filesystem and real processes.
 *
 * `ssh` itself was once the untested layer, on the reasoning that it was the
 * one least likely to be wrong: every command crosses it as base64 and nothing
 * in it can be mangled. That reasoning was sound about *commands* and the hole
 * was underneath it — uploads do not cross as base64, and the upload hung
 * forever the first time a real `sshd` carried it. Hence `over real ssh` below,
 * which is the only test here that can speak about the transport.
 *
 * These skip off Windows, where `powershell.exe` and `cmd.exe` do not exist.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { removeTemp } from './support/tempDir.js';
import { until } from './support/until.js';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  installWindowsNode,
  parseProbe,
  probeWindows,
  psCommand,
  readWindowsHostRecord,
  startWindowsHost,
  uploadWindowsBundles,
  windowsNodeExe,
  windowsNodeUrl,
  windowsSshRunner,
} from '@main/host/windowsBootstrap.js';
import { connectLoopback, listenLoopback, newControlToken } from '@shared/host/loopback.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { connectRemoteHost } from '@main/host/connectRemote.js';
import { freeLoopbackPort, systemSshRunner, type SshRunner } from '@main/host/sshTransport.js';
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
    // Just writes the bytes, deliberately. This used to run the same command the
    // real runner sent, which reads as the more faithful double and was in fact
    // the reason a hang shipped: `cmd.exe` on a real pipe delivers stdin EOF, so
    // streaming-into-stdin passed here and blocked forever over ssh. A double
    // that reproduces a transport it is not using proves nothing about it; the
    // only test that can is `over real ssh` below.
    upload: (_alias, remotePath, contents) => writeFile(remotePath, contents),
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
    await removeTemp(root);
  }
  /*
   * A longer deadline than the 10s default, because what is being removed is a
   * directory a *deliberately lingering* host still has open — `lingerMs` here is
   * 60s, so it outlives the test that started it, on purpose. `removeTemp`
   * retries for a couple of seconds per root against Windows sharing
   * violations, and under a full suite that overran the default and turned one
   * failed assertion into a second failure with an unrelated name.
   */
}, 120_000);

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
    // `detail` is the only thing that says *why* an unreachable probe failed,
    // and a bare `expected false to be true` sent me looking at the machine
    // rather than at the message the code had already written down.
    expect(probe.reachable, `probe failed: ${probe.detail}`).toBe(true);
    expect(probe.platform).toBe('Windows_NT');
    expect(['x64', 'arm64']).toContain(probe.arch);
    expect(probe.home).toBe(homedir());
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

    /*
     * Debris in the machine directory, planted on purpose.
     *
     * The launch script waits for `host.json` to appear and used to return the
     * first one it found, so a record left by a host that had been *killed* was
     * read as this launch's answer. Found by a suite that had just killed two:
     * the leftover described a named pipe, and a build with loopback support was
     * reported as one without it. A record is a hint (SS6.4) and the pid in it is
     * how a reader tells a hint from a fact.
     *
     * Pid 0 is never a process one can open, so this is debris by construction
     * rather than by hoping a number is free.
     */
    await mkdir(join(probe.home, '.agbrte'), { recursive: true });
    await writeFile(
      join(probe.home, '.agbrte', 'host.json'),
      JSON.stringify({ pid: 0, socket: String.raw`\\.\pipe\agbrte-nothing-here`, protocol: 1 }),
      'utf8',
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
    expect(identity.workspace?.root).toBe(workspace);
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

    /*
     * The token is a credential and the record is where it lives. On Windows
     * there is no mode to check, so what is asserted is that it exists at all
     * and is not in the log.
     *
     * **Waited for rather than read straight off.** The host opens the workspace
     * *before* it listens and publishes the pointer *after*, because the pointer
     * is for the next client to arrive rather than for the one already talking to
     * it (§8) — so a completed handshake is no promise that the file is on disk
     * yet. Read once, this raced under a full suite and failed with ENOENT while
     * the host was perfectly well.
     */
    const recordPath = join(workspace, '.agbrte', 'host.json');
    await until(() => existsSync(recordPath), 20_000, () => `${recordPath} was never written`);
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      token?: string;
      port?: number;
    };
    expect(record.token).toBe(started.token);
    expect(record.port).toBe(started.port);
    await expect(stat(recordPath)).resolves.toBeDefined();

    const log = await readFile(
      join(workspace, '.agbrte', 'sessions', session.sessionId, 'events.jsonl'),
      'utf8',
    );
    expect(log).not.toContain(started.token);

    await connection.requestShutdown().catch(() => undefined);
  }, 300_000);
});

/**
 * Finding a host that is already there, or finding out there is not one.
 *
 * These run against a real PowerShell and real loopback sockets, and they are
 * where the *POSIX* fix for this — "a record is a hint; a socket answering is a
 * fact" — finally gets asserted on the Windows side. It was not, which is how
 * `readWindowsHostRecord` went on returning a record it had never spoken to for
 * two releases after the same bug was found and fixed for `FIND_HOST_SCRIPT`.
 *
 * A temporary home throughout, never `homedir()`: the machine record is a real
 * file at a real path, and a test that writes debris into the developer's own
 * profile breaks the next attach they make by hand.
 */
onWindows('finding a host that is already there', () => {
  /** A machine directory and a workspace, both fresh, neither in the profile. */
  async function scratch(): Promise<{ home: string; machineDir: string; workspace: string }> {
    const home = await mkdtemp(join(tmpdir(), 'agbrte-winfind-'));
    roots.push(home);
    const machineDir = join(home, '.agbrte');
    await mkdir(machineDir, { recursive: true });
    const workspace = await mkdtemp(join(tmpdir(), 'agbrte-winfind-ws-'));
    roots.push(workspace);
    await mkdir(join(workspace, '.agbrte'), { recursive: true });
    return { home, machineDir, workspace };
  }

  /** A control port that answers the handshake, and the record describing it. */
  async function liveHost(): Promise<{ record: Record<string, unknown>; close: () => void }> {
    const token = newControlToken();
    const listener = await listenLoopback(token, (channel) => channel.close());
    closers.push(() => listener.server.close());
    return {
      record: { pid: process.pid, port: listener.port, token, protocol: 1, instanceId: 'live' },
      close: () => listener.server.close(),
    };
  }

  it('refuses a record nothing answers, so a rebooted machine can be attached again', async () => {
    const { machineDir, workspace, home } = await scratch();

    /*
     * The exact debris a reboot leaves: a well-formed record, written by a host
     * that really was listening on that port, describing a process that is gone.
     * `freeLoopbackPort` opens a port and closes it, so this is a port the OS
     * has just told us nobody holds — debris by construction rather than by
     * hoping a number is free.
     */
    const dead = await freeLoopbackPort();
    await writeFile(
      join(machineDir, 'host.json'),
      JSON.stringify({ pid: 0, port: dead, token: 'a'.repeat(64), protocol: 1, instanceId: 'x' }),
      'utf8',
    );

    const found = await readWindowsHostRecord(localWindowsRunner(), 'self', workspace, home);
    // Null is what makes the attach *recover*: `connectWindowsHost` starts a host
    // when there is no record, and used to be handed this one and forward into
    // nothing, permanently.
    expect(found, 'a record nobody answers was taken for a host').toBeNull();
  }, 120_000);

  it('takes one that completes the handshake', async () => {
    const { machineDir, workspace, home } = await scratch();
    const live = await liveHost();
    await writeFile(join(machineDir, 'host.json'), JSON.stringify(live.record), 'utf8');

    const found = await readWindowsHostRecord(localWindowsRunner(), 'self', workspace, home);
    expect(found?.port).toBe(live.record['port']);
    expect(found?.token).toBe(live.record['token']);
  }, 120_000);

  it('does not let a stale machine record hide a live one in the folder', async () => {
    const { machineDir, workspace, home } = await scratch();

    // Read first and dead, which is the ordering that produced this: the
    // workspace's pointer used to be consulted only when this *file was absent*.
    const dead = await freeLoopbackPort();
    await writeFile(
      join(machineDir, 'host.json'),
      JSON.stringify({ pid: 0, port: dead, token: 'b'.repeat(64), protocol: 1, instanceId: 'x' }),
      'utf8',
    );

    const live = await liveHost();
    await writeFile(join(workspace, '.agbrte', 'host.json'), JSON.stringify(live.record), 'utf8');

    const found = await readWindowsHostRecord(localWindowsRunner(), 'self', workspace, home);
    expect(found?.port, 'the stale profile record shadowed the live one').toBe(live.record['port']);
  }, 120_000);

  it('finds a host through the registry when no record names it', async () => {
    // The state a lost bind race leaves: the machine record and this folder's
    // pointer are both gone, and the host is answering for a folder it restored
    // earlier. Attaching a *new* folder has to work anyway, which is the whole
    // reason the POSIX script sweeps `workspaces.json`.
    const { machineDir, workspace, home } = await scratch();
    const served = await mkdtemp(join(tmpdir(), 'agbrte-winfind-served-'));
    roots.push(served);
    await mkdir(join(served, '.agbrte'), { recursive: true });

    const live = await liveHost();
    await writeFile(join(served, '.agbrte', 'host.json'), JSON.stringify(live.record), 'utf8');
    await writeFile(
      join(machineDir, 'workspaces.json'),
      JSON.stringify({ workspaces: [{ root: served }] }),
      'utf8',
    );

    const found = await readWindowsHostRecord(localWindowsRunner(), 'self', workspace, home);
    expect(found?.port, 'the registry was never swept').toBe(live.record['port']);
  }, 120_000);

  /**
   * The same two questions, asked of a **real host process** rather than of a
   * listener this file stood up.
   *
   * The tests above use `listenLoopback` directly, which proves the handshake is
   * spoken correctly and proves nothing about the thing that actually writes
   * these records. This one runs the shipped bundle, with its own machine
   * directory, on §6.2's loopback channel — so the record being read is one a
   * host wrote, at the path a host chooses, describing a port a host opened.
   *
   * Then it kills it the way the failure happens: abruptly. `child.kill()` on
   * Windows is `TerminateProcess`, there is no signal handler to run, and the
   * record stays on disk describing a process that is gone. That is the state a
   * remote is in after a reboot or an OOM kill, and it is the state in which
   * every attach used to fail for good.
   *
   * `AGBRTE_HOME` throughout, per §8 — without it this host would write its
   * machine record into the developer's own profile and the suite's parallel
   * files would fight over one socket.
   */
  it('finds a real host, and stops finding it the moment that host is killed', async () => {
    const { home, machineDir, workspace } = await scratch();
    const bundle = resolve(import.meta.dirname, '../dist/main/agbrteHost.js');
    expect(existsSync(bundle), `no host bundle at ${bundle} — run npm run build`).toBe(true);

    const host = spawn(process.execPath, [bundle, workspace], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        AGBRTE_HOME: machineDir,
        // The line that makes it a *Windows remote's* host rather than this
        // machine's: a named pipe cannot be forwarded, so §6.2's channel is the
        // only one an attach could reach.
        AGBRTE_HOST_CONTROL: 'loopback',
        AGBRTE_HOST_LINGER_MS: '120000',
      },
      windowsHide: true,
    });
    let said = '';
    host.stderr.on('data', (d) => (said += String(d)));
    closers.push(() => host.kill());

    const recordPath = join(machineDir, 'host.json');
    await until(() => existsSync(recordPath), 30_000, () => `no record was written: ${said}`);

    const found = await readWindowsHostRecord(localWindowsRunner(), 'self', workspace, home);
    expect(found?.port, `a live host was not found: ${said}`).toBeGreaterThan(0);
    // The token came back, because the app needs it to open the forward — and it
    // is the host's own, not one this test invented.
    expect(found?.token).toMatch(/^[0-9a-f]{64}$/);

    host.kill();
    await new Promise((done) => host.once('exit', done));

    // The corpse's record, still exactly where it was. Asserted rather than
    // assumed: if the host had cleaned up on the way out there would be nothing
    // here to be fooled by, and this test would be proving something else.
    expect(existsSync(recordPath), 'the killed host tidied up, so nothing lies').toBe(true);

    const gone = await readWindowsHostRecord(localWindowsRunner(), 'self', workspace, home);
    expect(gone, "a dead host was still being reported as this machine's").toBeNull();
  }, 120_000);

  it('says nothing when there is nothing, rather than failing', async () => {
    const { workspace, home } = await scratch();
    const found = await readWindowsHostRecord(localWindowsRunner(), 'self', workspace, home);
    expect(found).toBeNull();
  }, 120_000);
});

/**
 * The layer the local runner cannot reach: `ssh` itself.
 *
 * Everything above goes through `cmd.exe` on this machine, which is what Windows
 * `sshd` does with a command — but it skips the transport. This block runs the
 * same bootstrap through the real `ssh` client against `localhost`, including
 * the `ssh -L` tunnel, so nothing about the path is simulated.
 *
 * It needs an sshd on this machine reachable by key, which is an elevated
 * install, so it skips when there is none rather than failing. `scripts/enable-sshd.ps1`
 * sets one up bound to loopback only.
 */
describe('over real ssh, to this machine', () => {
  const ALIAS = 'localhost';

  /**
   * Is there an sshd here that key auth can reach without a prompt?
   *
   * **Says so out loud when there is not**, because these two are the only
   * tests that exercise the Windows transport at all and a silent skip is
   * indistinguishable from a pass in every place anybody looks. When the sshd
   * service stopped between two runs, the totals went from `1180 passed | 13
   * skipped` to `1178 passed | 15 skipped` and the summary line still read
   * `Test Files 76 passed` — the transport stopped being verified and nothing
   * said so.
   *
   * The skip is still the right behaviour: most machines running this suite
   * have no sshd, and failing there would train people to ignore a red suite.
   * What was wrong was doing it quietly.
   */
  /** Why ssh could not be used, or `null` when it can. */
  async function sshdUnreachable(): Promise<string | null> {
    if (process.platform !== 'win32') return 'not running on Windows';
    const r = await systemSshRunner().exec(ALIAS, 'echo ok');
    if (r.code === 0 && r.stdout.includes('ok')) return null;

    const last = (r.stderr.trim() || `ssh exited ${r.code}`).split('\n').slice(-1)[0]!.trim();
    // Written to the stream directly rather than through `console.warn`: Vitest
    // attaches intercepted console output to the task, and a task that then
    // skips renders none of it — so the warning disappeared exactly in the case
    // it exists for.
    process.stderr.write(
      `\n  ⚠ The Windows-over-ssh tests are being SKIPPED — the transport is NOT verified by this run.\n` +
        `    \`ssh ${ALIAS}\` did not answer: ${last}\n\n`,
    );
    return last;
  }

  it('bootstraps and serves a session through the tunnel', async (ctx) => {
    const why = await sshdUnreachable();
    if (why !== null) {
      ctx.skip(`ssh ${ALIAS} unavailable: ${why}`);
      return;
    }

    // The user's own ssh, with the one method a Windows remote cannot share.
    const runner = windowsSshRunner();

    // 1. The probe has to survive ssh, cmd.exe and PowerShell in one go.
    const probe = await probeWindows(runner, ALIAS);
    expect(probe.reachable).toBe(true);
    expect(probe.platform).toBe('Windows_NT');
    expect(probe.home).toBe(homedir());

    const node = probe.nodePath ?? windowsNodeExe(probe.home);
    const workspace = await mkdtemp(join(tmpdir(), 'agbrte-winssh-'));
    roots.push(workspace);

    // 2. Bundles cross by scp, staged and moved into place. This step is the
    //    reason this whole block exists: as a byte stream on stdin it passed
    //    every local test and hung here forever.
    await uploadWindowsBundles(
      runner,
      ALIAS,
      probe.home,
      {
        host: await readFile('dist/main/agbrteHost.js'),
        agent: await readFile('dist/main/agentHost.js'),
      },
      `winssh-${Date.now()}`,
    );

    // 3. Detached, through WMI, listening on a loopback port with a token.
    const started = await startWindowsHost(runner, ALIAS, probe.home, node, workspace, {
      lingerMs: 120_000,
    });
    expect(started.port).toBeGreaterThan(0);

    // 4. The tunnel. A Windows host cannot use a named pipe — `ssh -L` will not
    //    forward one — so this is why §6.2's loopback channel had to exist.
    const localPort = await freeLoopbackPort();
    const forward = await runner.forward(ALIAS, localPort, `127.0.0.1:${started.port}`);
    closers.push(() => forward.close());

    // 5. And it is an ordinary session from here down.
    const channel = await connectLoopback<SessionCommand, SessionMessage>(
      localPort,
      started.token,
    );
    const connection = new HostConnection({ channel, client: 'agbrte-test@win-over-ssh' });
    closers.push(() => connection.disconnect());

    const identity = await connection.ready;
    expect(identity.workspace?.root).toBe(workspace);

    const session = await connection.createSession({ title: 'over ssh', goal: 'g' });
    const agent = await connection.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
    });
    await connection.send(
      session.sessionId as SessionId,
      agent.agentId as AgentId,
      'a turn on a Windows host over ssh',
    );

    const events = await connection.events(session.sessionId as SessionId);
    expect(events.map((e) => e.type)).toContain('agent.stopped');
    expect(JSON.stringify(events)).toContain('a turn on a Windows host over ssh');

    await connection.requestShutdown().catch(() => undefined);
  }, 300_000);

  /**
   * The same machine, reached the way the *app* reaches one.
   *
   * The test above proves every Windows piece works and proves nothing about
   * whether anything calls them — which is the failure this project keeps
   * producing: correct code behind a seam nobody crosses. When it first passed,
   * `connectRemoteHost` still ran the POSIX bootstrap against every remote and
   * the only reference to `windowsBootstrap.ts` outside itself was a comment
   * claiming Windows worked. Every capability table can say `observed` while the
   * product cannot attach a single Windows machine.
   *
   * So: no runner is injected. `connectRemoteHost` picks its own, which means
   * the POSIX probe genuinely runs first, genuinely fails against `cmd.exe`, and
   * the Windows fallback is genuinely what recovers — the branch under test is
   * the one production takes, not one this test arranged.
   */
  it('is what connectRemoteHost reaches, with nothing injected', async (ctx) => {
    const why = await sshdUnreachable();
    if (why !== null) {
      ctx.skip(`ssh ${ALIAS} unavailable: ${why}`);
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), 'agbrte-winconn-'));
    roots.push(workspace);

    const steps: string[] = [];
    const version = `winconn-${Date.now()}`;
    const remote = await connectRemoteHost({
      alias: ALIAS,
      workspaceRoot: workspace,
      bundles: {
        host: await readFile('dist/main/agbrteHost.js', 'utf8'),
        agent: await readFile('dist/main/agentHost.js', 'utf8'),
      },
      bundleVersion: version,
      lingerMs: 120_000,
      onProgress: (s) => steps.push(s),
    });
    closers.push(() => remote.close());

    const identity = await remote.connection.ready;
    expect(identity.workspace?.root).toBe(workspace);

    const session = await remote.connection.createSession({ title: 'via connect', goal: 'g' });
    const agent = await remote.connection.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
    });
    await remote.connection.send(
      session.sessionId as SessionId,
      agent.agentId as AgentId,
      'reached through connectRemoteHost',
    );

    const events = await remote.connection.events(session.sessionId as SessionId);
    expect(events.map((e) => e.type)).toContain('agent.stopped');
    expect(JSON.stringify(events)).toContain('reached through connectRemoteHost');

    // It started one, because the workspace is new.
    expect(steps).toContain('starting the host');

    /**
     * And a second attach reuses it rather than starting a rival.
     *
     * §6.4's promise, and the reason `readWindowsHostRecord` had to exist:
     * without it this call launches a *second* host against the same workspace
     * and two processes append to one event log. That is silent, survives a
     * casual look, and corrupts the one thing the store exists to protect.
     */
    const again = await connectRemoteHost({
      alias: ALIAS,
      workspaceRoot: workspace,
      // The version just deployed, so the deploy step is skipped — which is half
      // of what "reattaching is cheap" means, and is asserted below. Passing a
      // fresh version with empty bundles here would have re-uploaded an empty
      // file over the working host and made the reuse assertion meaningless.
      bundles: { host: '', agent: '' },
      bundleVersion: version,
      onProgress: (s) => steps.push(s),
    });
    closers.push(() => again.close());
    const second = await again.connection.ready;
    expect(second.workspace?.instanceId, 'a second host was started').toBe(identity.workspace?.instanceId);
    expect(steps.filter((s) => s === 'starting the host')).toHaveLength(1);

    await remote.connection.requestShutdown().catch(() => undefined);
  }, 300_000);
});
