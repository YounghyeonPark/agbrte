/**
 * Reading `~/.ssh/config` to offer the user their own machines (§6.2, §14).
 *
 * Deliberately shallow, and the tests hold it to that: it lists what could
 * follow `ssh `, and nothing else. No `Match` evaluation, no wildcard expansion,
 * no canonicalisation — those belong to `ssh`, and a picker that reimplements
 * them ends up disagreeing with the command it eventually runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSshHosts } from '@main/host/sshConfig.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gilmok-sshcfg-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function config(body: string, name = 'config'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body, 'utf8');
  return path;
}

describe('listing hosts', () => {
  it('lists aliases with the details worth showing', async () => {
    const path = await config(`
Host build-01
  HostName build01.internal
  User ci
  Port 2222

Host laptop
  HostName 10.0.0.5
`);

    const hosts = await readSshHosts({ path });

    expect(hosts.map((h) => h.alias)).toEqual(['build-01', 'laptop']);
    expect(hosts[0]).toMatchObject({
      alias: 'build-01',
      hostName: 'build01.internal',
      user: 'ci',
      port: 2222,
    });
  });

  it('takes several aliases from one Host line', async () => {
    const path = await config('Host alpha beta\n  HostName shared.internal\n');
    const hosts = await readSshHosts({ path });

    // `ssh alpha` and `ssh beta` both work, so both belong in the picker.
    expect(hosts.map((h) => h.alias)).toEqual(['alpha', 'beta']);
    expect(hosts.every((h) => h.hostName === 'shared.internal')).toBe(true);
  });

  it('skips wildcard patterns, which are defaults and not destinations', async () => {
    const path = await config(`
Host *
  ServerAliveInterval 60

Host *.internal
  User ci

Host !excluded
  User nobody

Host real
  HostName real.example
`);

    // Offering `*` in a picker would be offering a wildcard as a machine.
    expect((await readSshHosts({ path })).map((h) => h.alias)).toEqual(['real']);
  });

  it('accepts the `Key=value` form and odd spacing', async () => {
    const path = await config('Host=terse\n\tHostName=terse.example\n   User   ci  \n');
    expect(await readSshHosts({ path })).toEqual([
      { alias: 'terse', hostName: 'terse.example', user: 'ci', source: expect.any(String) },
    ]);
  });

  it('is case-insensitive about keywords, as ssh is', async () => {
    const path = await config('HOST loud\n  hostname loud.example\n  USER ci\n');
    expect((await readSshHosts({ path }))[0]).toMatchObject({
      alias: 'loud',
      hostName: 'loud.example',
      user: 'ci',
    });
  });

  it('ignores comments and blank lines', async () => {
    const path = await config('# a note\n\nHost real\n  # indented note\n  User ci\n');
    expect((await readSshHosts({ path })).map((h) => h.alias)).toEqual(['real']);
  });

  it('handles a quoted alias', async () => {
    const path = await config('Host "spaced name"\n  HostName x.example\n');
    expect((await readSshHosts({ path })).map((h) => h.alias)).toEqual(['spaced name']);
  });
});

describe('Include', () => {
  it('follows an include relative to the including file', async () => {
    await mkdir(join(dir, 'conf.d'), { recursive: true });
    await writeFile(join(dir, 'conf.d', 'work'), 'Host work-box\n  User ci\n', 'utf8');
    const path = await config('Include conf.d/work\n\nHost home-box\n  User me\n');

    // Split configs are common enough that missing Include means an empty picker
    // for a lot of people.
    expect((await readSshHosts({ path })).map((h) => h.alias)).toEqual(['home-box', 'work-box']);
  });

  it('survives a config that includes itself', async () => {
    const path = join(dir, 'loop');
    await writeFile(path, `Include ${path}\nHost solo\n  User me\n`, 'utf8');

    // A cycle would otherwise recurse until the stack gives out.
    expect((await readSshHosts({ path })).map((h) => h.alias)).toEqual(['solo']);
  });

  it('ignores an include that is not there', async () => {
    const path = await config('Include nope/missing\nHost real\n  User me\n');
    expect((await readSshHosts({ path })).map((h) => h.alias)).toEqual(['real']);
  });
});

describe('robustness', () => {
  it('returns nothing when there is no config', async () => {
    // The common case on a fresh machine, and not a reason to fail an attach —
    // the user can still type a host.
    expect(await readSshHosts({ path: join(dir, 'absent') })).toEqual([]);
  });

  it('keeps the first definition when an alias repeats', async () => {
    const path = await config(`
Host dup
  User first

Host dup
  User second
`);
    // `ssh` applies the first obtained value for a keyword, so a picker showing
    // the second would be describing a connection that will not happen.
    expect((await readSshHosts({ path }))[0]?.user).toBe('first');
  });

  it('ignores a malformed line rather than giving up on the file', async () => {
    const path = await config('!!!\nHost real\n  User me\n');
    expect((await readSshHosts({ path })).map((h) => h.alias)).toEqual(['real']);
  });

  it('records where each alias came from', async () => {
    const path = await config('Host real\n');
    // So a user can find where a name is defined when two files disagree.
    expect((await readSshHosts({ path }))[0]?.source).toContain('config');
  });
});
