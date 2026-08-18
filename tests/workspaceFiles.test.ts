/**
 * Browsing a workspace, and the bounds that make it safe (DESIGN.md §6.6, §7, §13).
 *
 * This is a path from a **client** to a **filesystem**, so the interesting
 * assertions are all refusals. Three properties, and each has cost somebody
 * something in some other project:
 *
 *  - A path that escapes the root is refused *by name*, lexically and through a
 *    symlink. The lexical case is the obvious one; the symlink case is the one
 *    that gets missed, because `resolve()` cannot see through a link and the
 *    check that stops `../../etc` passes happily on a link that points there.
 *  - A directory is capped and **says so**, with the count that did not fit.
 *  - A file is returned whole or refused. Oversized and non-text come back as
 *    errors with names on them, never as a truncated string, because a
 *    half-file on screen with no marker is a bug report waiting to happen.
 *
 * The last block drives the real `SessionHostServer` over an in-memory channel,
 * because two of the claims are about the *protocol* rather than the function:
 * a `read-only` client may do both (they are reads, like `session.events`), and
 * a host older than v19 says which command it lacks rather than hanging.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MAX_ENTRIES,
  MAX_PREVIEW_BYTES,
  listDirectory,
  readTextFile,
} from '@main/workspace/files.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { CommandUnavailable, HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { InstanceId, LineageId } from '@shared/types/index.js';

let root: string;
/** A sibling of the workspace, so "outside" is a real directory and not a guess. */
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'agbrte-files-'));
  root = join(base, 'workspace');
  outside = join(base, 'secrets');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'passwd'), 'root:x:0:0');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# hello\n');
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
});

afterEach(async () => {
  await rm(resolve(root, '..'), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('paths that escape the workspace', () => {
  it('refuses a relative traversal by name, without touching the disk', async () => {
    await expect(listDirectory(root, '../secrets')).rejects.toMatchObject({
      name: 'PathOutsideWorkspace',
    });
    await expect(readTextFile(root, '../secrets/passwd')).rejects.toMatchObject({
      name: 'PathOutsideWorkspace',
    });
  });

  it('refuses an absolute path, even one that exists', async () => {
    const target = join(outside, 'passwd');
    await expect(readTextFile(root, target)).rejects.toMatchObject({
      name: 'PathOutsideWorkspace',
    });
  });

  it('refuses a deep traversal dressed up as a nested path', async () => {
    await expect(listDirectory(root, 'src/../../secrets')).rejects.toMatchObject({
      name: 'PathOutsideWorkspace',
    });
  });

  /**
   * The case a lexical check cannot catch.
   *
   * `escape/passwd` resolves *inside* the workspace by every string operation
   * available — it is only the filesystem that knows it leads somewhere else. So
   * this is the assertion that the second, `realpath`-based check exists at all;
   * delete it and the first three tests still pass.
   *
   * Skipped where the OS will not make one: an unprivileged Windows account
   * without Developer Mode cannot create a symlink, and a test that quietly
   * passed there would be a test that never ran on the machine this was written
   * on. It is stated as a skip so the gap is visible.
   */
  it('refuses a symlink that leads out, which the lexical check cannot see', async () => {
    let made = true;
    try {
      await symlink(outside, join(root, 'escape'), 'junction');
    } catch {
      made = false;
    }
    if (!made) {
      console.warn('symlinks are not creatable here — the link-escape check was not exercised');
      return;
    }

    await expect(listDirectory(root, 'escape')).rejects.toMatchObject({
      name: 'PathOutsideWorkspace',
    });
    await expect(readTextFile(root, 'escape/passwd')).rejects.toMatchObject({
      name: 'PathOutsideWorkspace',
    });
  });

  it('names a path that is simply not there, rather than reporting an escape', async () => {
    // A different refusal for a different fact. Collapsing the two would tell
    // somebody their typo was a security problem.
    await expect(listDirectory(root, 'nope')).rejects.toMatchObject({ name: 'NoSuchPath' });
  });

  it('lists the root for an empty path, which is what a browser opens on', async () => {
    const listing = await listDirectory(root, '');
    expect(listing.path).toBe('');
    expect(listing.entries.map((e) => e.name)).toEqual(['src', 'README.md']);
    // Directories first, then files — the order every file browser has, and not
    // the order the filesystem happened to return.
    expect(listing.entries[0]?.kind).toBe('dir');
    expect(listing.entries[1]?.kind).toBe('file');
    expect(listing.entries[1]?.size).toBe('# hello\n'.length);
  });

  it('answers about one directory and never its children', async () => {
    const listing = await listDirectory(root, '');
    // The whole incremental design in one assertion: `src` is here, and what is
    // *in* `src` is not. A shape that walked would have to put it somewhere.
    expect(listing.entries.some((e) => e.name === 'index.ts')).toBe(false);
    const nested = await listDirectory(root, 'src');
    expect(nested.path).toBe('src');
    expect(nested.entries.map((e) => e.path)).toEqual(['src/index.ts']);
  });
});

describe('caps, and saying when one bit', () => {
  it('stops at the entry cap and reports how many it left out', async () => {
    const many = join(root, 'many');
    await mkdir(many);
    const count = MAX_ENTRIES + 25;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        writeFile(join(many, `f${String(i).padStart(4, '0')}.txt`), 'x'),
      ),
    );

    const listing = await listDirectory(root, 'many');
    expect(listing.entries).toHaveLength(MAX_ENTRIES);
    // The count, not a flag: the sentence on screen is "25 more", and a boolean
    // could only say "some more" — which is the difference between a directory
    // somebody can reason about and one they cannot.
    expect(listing.truncated).toBe(25);
    expect(listing.limit).toBe(MAX_ENTRIES);
  });

  it('lets a client ask for fewer and never for more', async () => {
    const many = join(root, 'many');
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeFile(join(many, `f${i}.txt`), 'x')),
    );

    const few = await listDirectory(root, 'many', { limit: 5 });
    expect(few.entries).toHaveLength(5);
    expect(few.truncated).toBe(15);

    // The cap belongs to the host, because a large request is what a large
    // request costs the host.
    const greedy = await listDirectory(root, 'many', { limit: 1_000_000 });
    expect(greedy.limit).toBe(MAX_ENTRIES);
  });

  it('refuses an oversized file by name rather than truncating it', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(MAX_PREVIEW_BYTES + 1));
    // Not "returns the first 256 KB". A half-file on screen with no marker is
    // worse than a refusal, and a truncating read is how megabytes end up
    // crossing the IPC boundary one exception at a time.
    await expect(readTextFile(root, 'big.txt')).rejects.toMatchObject({ name: 'FileTooLarge' });
    await expect(readTextFile(root, 'big.txt')).rejects.toThrow(/256 KB/);
  });

  it('returns a file that sits exactly on the cap', async () => {
    await writeFile(join(root, 'edge.txt'), 'y'.repeat(MAX_PREVIEW_BYTES));
    const preview = await readTextFile(root, 'edge.txt');
    expect(preview.bytes).toBe(MAX_PREVIEW_BYTES);
  });

  it('refuses binary by sniffing the bytes, not by trusting the extension', async () => {
    // Named `.txt` on purpose: an extension is a claim about a filename and this
    // is an observation about the contents.
    await writeFile(join(root, 'image.txt'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]));
    await expect(readTextFile(root, 'image.txt')).rejects.toMatchObject({ name: 'FileNotText' });
  });

  it('refuses bytes that are not valid UTF-8', async () => {
    await writeFile(join(root, 'latin1.txt'), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]));
    await expect(readTextFile(root, 'latin1.txt')).rejects.toMatchObject({ name: 'FileNotText' });
  });

  it('refuses a directory asked for as a file', async () => {
    await expect(readTextFile(root, 'src')).rejects.toMatchObject({ name: 'NotAFile' });
    await expect(listDirectory(root, 'README.md')).rejects.toMatchObject({
      name: 'NotADirectory',
    });
  });

  it('returns a text file whole, with POSIX separators on the way back', async () => {
    const preview = await readTextFile(root, 'src/index.ts');
    expect(preview.text).toBe('export const x = 1;\n');
    // The wire form is POSIX whatever this machine's separator is, because the
    // host may be Linux while the app is Windows.
    expect(preview.path).toBe('src/index.ts');
  });
});

describe('over the protocol', () => {
  interface Rig {
    connect(opts?: { role?: 'read-write' | 'read-only'; protocol?: number }): HostConnection;
  }

  async function rig(): Promise<Rig> {
    const identity = await openWorkspace(root);
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: identity.instanceId as InstanceId,
    });
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId: identity.instanceId as InstanceId,
        lineageId: identity.lineageId as LineageId,
        workspaceRoot: root,
        runtimes: ['echo'],
      },
    });
    return {
      connect: (o = {}) => {
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({
          channel: pair.main,
          ...(o.role !== undefined ? { role: o.role } : {}),
        });
      },
    };
  }

  it('serves a read-only client, because listing and reading are reads', async () => {
    const { connect } = await rig();
    const client = connect({ role: 'read-only' });
    await client.ready;
    expect(client.role).toBe('read-only');

    // The same treatment `session.events` and `blob.get` get. A read-only client
    // can already read a transcript that names these files; withholding the list
    // would keep the caption and hide the picture.
    const listing = await client.listFiles('');
    expect(listing.entries.map((e) => e.name)).toContain('README.md');
    expect((await client.readFile('README.md')).text).toBe('# hello\n');
  });

  it('carries the refusal name across the wire, so a pane can say which cap bit', async () => {
    const { connect } = await rig();
    const client = connect();
    await client.ready;
    await expect(client.listFiles('../secrets')).rejects.toMatchObject({
      name: 'PathOutsideWorkspace',
    });
  });

  it('writes nothing to the session log — this is a view, not an event', async () => {
    const { connect } = await rig();
    const client = connect();
    await client.ready;

    const before = await client.list();
    await client.listFiles('');
    await client.listFiles('src');
    await client.readFile('src/index.ts');
    const after = await client.list();

    // Nothing created, nothing changed. The stronger form of this claim — that
    // `events.jsonl` on disk is untouched — is asserted end-to-end in
    // `tests/e2e/files.spec.ts`, where there is a real session with a real log.
    expect(after).toEqual(before);
  });

  it('tells a client which command an older host lacks', async () => {
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    const client = new HostConnection({ channel: pair.main });
    // A v18 host: everything up to the terminal, and no file browsing. The
    // client learns this from `welcome` and declines to send, so meeting one
    // costs a sidebar rather than the connection.
    pair.host.post({
      t: 'welcome',
      id: 'c1',
      role: 'read-write',
      identity: {
        instanceId: 'i' as InstanceId,
        lineageId: 'l' as LineageId,
        workspaceRoot: root,
        runtimes: [],
        pid: 1,
        protocol: 18,
      },
    });

    // Awaited, because the handshake lands on the channel's own turn — asking
    // `supports` before it does answers about a connection with no identity yet,
    // which is `false` for everything and would let this pass for the wrong
    // reason.
    await client.ready;

    expect(client.supports('files.list')).toBe(false);
    expect(client.supports('shell.open')).toBe(true);
    await Promise.all([
      expect(client.listFiles('')).rejects.toBeInstanceOf(CommandUnavailable),
      expect(client.readFile('README.md')).rejects.toThrow(/needs v19/),
    ]);
  });
});
