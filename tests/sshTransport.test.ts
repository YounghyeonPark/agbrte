/**
 * The SSH transport's decisions, without a server (DESIGN.md §6.2, §6.4).
 *
 * The transport was built against a real host and every case here is a bug that
 * run actually produced. That is why they are worth keeping: each one cost a
 * round trip to a live machine to find, and none of them would have been caught
 * by a type or a review.
 *
 * The parts that need a server — whether `ssh -L` reaches a remote unix socket,
 * whether a detached child outlives its session — cannot be faked and are not
 * pretended at here.
 */

import { describe, expect, it } from 'vitest';
import {
  nodeTarballUrl,
  probeRemote,
  remoteAgentBundle,
  remoteBundle,
  remoteNodeBin,
  remoteRoot,
  shellQuote,
  startRemoteHost,
  uploadHostBundle,
  type SshRunner,
} from '@main/host/sshTransport.js';

/** Records what would have been run, and replies with canned output. */
function fakeRunner(
  replies: Array<{ match: RegExp; code?: number; stdout?: string; stderr?: string }> = [],
): SshRunner & { commands: string[]; uploads: string[] } {
  const commands: string[] = [];
  const uploads: string[] = [];
  return {
    commands,
    uploads,
    exec: async (_alias, command) => {
      commands.push(command);
      const reply = replies.find((r) => r.match.test(command));
      return {
        code: reply?.code ?? 0,
        stdout: reply?.stdout ?? '',
        stderr: reply?.stderr ?? '',
      };
    },
    upload: async (_alias, path) => {
      uploads.push(path);
    },
    forward: async () => ({ close: () => undefined }),
  };
}

describe('remote paths', () => {
  it('are absolute, never tilde', () => {
    const home = '/home/someone';
    for (const path of [
      remoteRoot(home),
      remoteBundle(home),
      remoteAgentBundle(home),
      remoteNodeBin(home),
    ]) {
      // A quoted `~` reaches the remote as a directory literally named "~", and
      // the resulting "No such file or directory" points at the wrong thing.
      // Paths must be quoted to be safe in `sh -c`, so they cannot rely on
      // expansion.
      expect(path.startsWith('/home/someone/')).toBe(true);
      expect(path).not.toContain('~');
    }
  });
});

describe('shellQuote', () => {
  it('survives a path with a space', () => {
    expect(shellQuote('/home/a b/ws')).toBe(`'/home/a b/ws'`);
  });

  it('survives an embedded single quote', () => {
    // The one character that can close the quoting and let the rest of a path be
    // read as shell syntax.
    expect(shellQuote("/home/o'brien")).toBe(`'/home/o'\\''brien'`);
  });
});

describe('probing', () => {
  it('reads what the remote reported', async () => {
    const runner = fakeRunner([
      {
        match: /uname/,
        stdout: 'home=/home/ci\narch=x86_64\nplatform=Linux\nnode=/usr/bin/node\nbundle=v3\n',
      },
    ]);

    const probe = await probeRemote(runner, 'box');
    expect(probe).toMatchObject({
      reachable: true,
      home: '/home/ci',
      arch: 'x86_64',
      nodePath: '/usr/bin/node',
      bundleVersion: 'v3',
    });
  });

  it('reports absent Node and absent bundle as null, not empty string', async () => {
    const runner = fakeRunner([
      { match: /uname/, stdout: 'home=/home/ci\narch=x86_64\nplatform=Linux\nnode=\nbundle=\n' },
    ]);

    const probe = await probeRemote(runner, 'box');
    // The caller branches on these; `''` is truthy enough to slip through a
    // careless check and then be used as a path.
    expect(probe.nodePath).toBeNull();
    expect(probe.bundleVersion).toBeNull();
  });

  it('asks once rather than five times', async () => {
    const runner = fakeRunner([{ match: /uname/, stdout: 'home=/h\narch=x86_64\nplatform=Linux\n' }]);
    await probeRemote(runner, 'box');
    // Every ssh invocation is a full connection setup, and latency is the thing
    // remote execution exists to avoid (§6.3).
    expect(runner.commands).toHaveLength(1);
  });

  it('reports unreachable with the reason ssh gave', async () => {
    const runner = fakeRunner([{ match: /uname/, code: 255, stderr: 'Permission denied (publickey)' }]);
    const probe = await probeRemote(runner, 'box');

    // The user's own ssh already explained it; replacing that with our guess
    // would be strictly less useful.
    expect(probe.reachable).toBe(false);
    expect(probe.detail).toContain('publickey');
  });
});

describe('node tarball selection', () => {
  it('maps uname output to Node’s own naming', () => {
    expect(nodeTarballUrl('Linux', 'x86_64')).toContain('linux-x64');
    expect(nodeTarballUrl('Linux', 'aarch64')).toContain('linux-arm64');
    expect(nodeTarballUrl('Darwin', 'arm64')).toContain('darwin-arm64');
  });

  it('pins a version so a host is reproducible', () => {
    expect(nodeTarballUrl('Linux', 'x86_64')).toMatch(/\/v\d+\.\d+\.\d+\//);
  });
});

describe('deploying', () => {
  it('ships both bundles, session host last', async () => {
    const runner = fakeRunner();
    await uploadHostBundle(
      runner,
      'box',
      '/home/ci',
      { host: 'package.json', agent: 'package.json' },
      'v1',
    );

    // Two files because the session host forks the agent host. Shipping only the
    // first surfaced as "could not resolve capabilities: agent host exited with
    // code 1" — a message about the wrong layer entirely.
    expect(runner.uploads).toEqual([
      '/home/ci/.loom/agentHost.js',
      // Last, because the probe reads its stamp as "both are deployed".
      '/home/ci/.loom/loomHost.js',
    ]);
  });
});

describe('starting the host', () => {
  const record = '{"pid":42,"socket":"/tmp/s.sock","protocol":1,"instanceId":"i"}';

  it('detaches the launcher from the ssh channel', async () => {
    const runner = fakeRunner([{ match: /nohup/, stdout: record }]);
    await startRemoteHost(runner, 'box', '/home/ci', '/n/bin/node', '/w');

    const command = runner.commands[0] ?? '';
    // A backgrounded subshell inherits the channel's stdout and stderr, and
    // `ssh` does not return until every holder closes them — so the command
    // succeeds and the caller hangs forever waiting for a long-lived host.
    expect(command).toContain(') >/dev/null 2>&1');
    expect(command).toContain('nohup setsid');
  });

  it('waits for the record on the remote, in the same command', async () => {
    const runner = fakeRunner([{ match: /nohup/, stdout: record }]);
    const started = await startRemoteHost(runner, 'box', '/home/ci', '/n/bin/node', '/w');

    // Waiting remotely keeps the session open past the point where a freshly
    // started child would be killed by it closing — and removes up to forty
    // connection setups from a first attach.
    expect(runner.commands).toHaveLength(1);
    expect(runner.commands[0]).toContain('for i in $(seq 1');
    expect(started.pid).toBe(42);
  });

  it('does not put a `;` after the background `&`', async () => {
    const runner = fakeRunner([{ match: /nohup/, stdout: record }]);
    await startRemoteHost(runner, 'box', '/home/ci', '/n/bin/node', '/w');

    // `&` already terminates a command, so `… &; for …` is a syntax error rather
    // than a background job — and bash reports it as one, which reads like a
    // quoting problem.
    expect(runner.commands[0]).not.toContain('&;');
  });

  it('reports the log when the host never becomes ready', async () => {
    const runner = fakeRunner([{ match: /nohup/, code: 1, stderr: 'TIMEOUT\nEACCES /tmp' }]);
    await expect(
      startRemoteHost(runner, 'box', '/home/ci', '/n/bin/node', '/w'),
    ).rejects.toThrow(/EACCES/);
  });

  it('passes the linger through so a host does not sit forever', async () => {
    const runner = fakeRunner([{ match: /nohup/, stdout: record }]);
    await startRemoteHost(runner, 'box', '/home/ci', '/n/bin/node', '/w', { lingerMs: 1234 });
    expect(runner.commands[0]).toContain('LOOM_HOST_LINGER_MS=1234');
  });
});
