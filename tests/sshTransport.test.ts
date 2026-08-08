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
  describeSshFailure,
  diagnoseSshFailure,
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
      '/home/ci/.agbrte/agentHost.js',
      // Last, because the probe reads its stamp as "both are deployed".
      '/home/ci/.agbrte/agbrteHost.js',
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

  it('creates the workspace if it is not there', async () => {
    const runner = fakeRunner([{ match: /nohup/, stdout: record }]);
    await startRemoteHost(runner, 'box', '/home/ci', '/n/bin/node', '/w/new');

    // The local flow's folder picker can create one, so refusing here would mean
    // the user has to ssh in and mkdir — the friction this exists to remove.
    expect(runner.commands[0]).toContain(`mkdir -p '/w/new'`);
  });

  it('truncates the log before launching', async () => {
    const runner = fakeRunner([{ match: /nohup/, stdout: record }]);
    await startRemoteHost(runner, 'box', '/home/ci', '/n/bin/node', '/w');

    // A failure *before* launch would otherwise tail the previous run's log, and
    // a stale "listening" line under a startup failure says the thing that just
    // failed worked.
    expect(runner.commands[0]).toContain(': >');
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
    expect(runner.commands[0]).toContain('AGBRTE_HOST_LINGER_MS=1234');
  });
});

/**
 * Telling the user what went wrong (§6.2).
 *
 * There is no ssh configuration to "have" — `ssh user@host` works with none —
 * but a first connection fails in four distinct ways that need four different
 * actions. Every string below came from OpenSSH against a live host, not from
 * guessing at what it might say.
 */
describe('diagnosing a failed connection', () => {
  it('recognises a host key that has not been confirmed', () => {
    const d = diagnoseSshFailure('build-01', 'Host key verification failed.');

    expect(d.kind).toBe('unknown-host-key');
    // Deliberately a terminal command, not a button. Trust-on-first-use only
    // means something if a human checks the fingerprint against something other
    // than the connection presenting it; accepting it for them would turn a real
    // check into a formality.
    expect(d.command).toBe('ssh build-01');
    expect(d.fix).toMatch(/will not accept a key on your behalf/);
  });

  it('recognises refused credentials and points at the fix', () => {
    const d = diagnoseSshFailure('build-01', 'ci@10.0.0.5: Permission denied (publickey).');

    expect(d.kind).toBe('auth-refused');
    // Agbrte cannot prompt for a password — it runs ssh with BatchMode so a prompt
    // fails fast rather than hanging on a stdin nobody is attached to.
    expect(d.command).toBe('ssh-copy-id build-01');
  });

  it('recognises a name that does not resolve', () => {
    const d = diagnoseSshFailure(
      'typo',
      'ssh: Could not resolve hostname typo: Name or service not known',
    );

    expect(d.kind).toBe('name-resolution');
    // The case this question is really about: no config at all. `user@host`
    // always works, so the guidance says so rather than implying a config is
    // required.
    expect(d.fix).toMatch(/user@hostname/);
  });

  it('recognises a machine that never answered', () => {
    expect(diagnoseSshFailure('box', 'ssh: connect to host box port 22: Connection timed out').kind)
      .toBe('unreachable');
    expect(diagnoseSshFailure('box', 'ssh: connect to host box port 22: Connection refused').kind)
      .toBe('unreachable');
  });

  it('recognises a missing ssh client', () => {
    // Windows without the optional OpenSSH feature — the only case where the
    // user has nothing to connect *with*.
    expect(diagnoseSshFailure('box', 'spawn ssh ENOENT').kind).toBe('no-ssh-client');
  });

  it('falls back without pretending to know', () => {
    const d = diagnoseSshFailure('box', 'something nobody anticipated');
    expect(d.kind).toBe('unknown');
    expect(d.fix).toMatch(/running the same command in a terminal/);
  });

  it('renders one line that keeps the action ahead of the noise', () => {
    const rendered = describeSshFailure(
      'build-01',
      'Host key verification failed.\nchatter nobody needs\nmore chatter',
    );

    expect(rendered).toContain('Try: ssh build-01');
    // ssh is often chatty after the sentence that matters, and the rest pushes
    // the actionable part off the end of a one-line error.
    expect(rendered).not.toContain('more chatter');
  });
});
