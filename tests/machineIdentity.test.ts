/**
 * A machine has its own identity, and its own directory (DESIGN.md §5.2, §8).
 *
 * Three ids now, and the third is not a rename of the second. `lineageId` is a
 * repository, `instanceId` is one checkout of it on one machine, and `machineId`
 * is the machine — one install area, one set of credentials, one lease
 * authority, one host process. They were conflated for as long as a host was one
 * per workspace, which is why a fleet holding two folders on one build box
 * reported "those sessions are on 2 machines".
 *
 * The other half these tests exist for is §5.1's shared name: `~/.agbrte` and
 * `<workspace>/.agbrte` spell themselves the same way on purpose, and nothing
 * may confuse a machine's install area with a workspace's data.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineFilePath, machineIdentity, machineRoot } from '../src/host/machine.js';
import { endpointsPath } from '../src/host/endpoints.js';
import { assertNotInstallRoot, workspaceLayout, WORKSPACE_DIR } from '@main/store/layout.js';
import { isUuid } from '@shared/types/index.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agbrte-home-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('the machine id', () => {
  it('is minted once and read every time after', async () => {
    const first = await machineIdentity(home);
    const second = await machineIdentity(home);

    expect(isUuid(first.machineId)).toBe(true);
    expect(second.machineId).toBe(first.machineId);
  });

  it('lives beside the machine\'s other things, not in any workspace', async () => {
    await machineIdentity(home);

    expect(machineFilePath(home)).toBe(join(home, '.agbrte', 'machine.json'));
    // The credentials file is the neighbour that makes the point: §8.2 puts it
    // in the machine's directory rather than in a workspace precisely because a
    // workspace is inside somebody's git repository. Asserted against
    // `machineRoot()` rather than against the literal `.agbrte`, because
    // `AGBRTE_HOME` moves that directory and both readers must move with it.
    expect(endpointsPath()).toBe(join(machineRoot(), 'endpoints.json'));
  });

  /**
   * The whole point of the variable, asserted where it was quietly lost.
   *
   * `machineRoot` honours `AGBRTE_HOME` only when it is *given no argument* — an
   * explicit one is a caller who knows which directory they mean. So a signature
   * that defaults to `homedir()` never reaches that branch, and both of these
   * did: every reader of the machine id went to `$HOME/.agbrte` no matter where
   * the installation had been moved.
   *
   * It reads as a small thing and is not, because the socket is named from this
   * id: two installations on one machine, which is the case `AGBRTE_HOME` exists
   * for, computed the same socket and fought over it. A parallel test run is
   * simply that case at scale — one file's client reaching another file's host —
   * and it failed a release on all three platforms while passing serially here.
   */
  it('follows AGBRTE_HOME when nobody names a directory', async () => {
    const previous = process.env['AGBRTE_HOME'];
    process.env['AGBRTE_HOME'] = join(home, 'moved');
    try {
      expect(machineFilePath()).toBe(join(home, 'moved', 'machine.json'));
      const minted = await machineIdentity();
      // Read back through the path the variable names, not through the default.
      const onDisk = JSON.parse(await readFile(machineFilePath(), 'utf8')) as {
        machineId?: string;
      };
      expect(onDisk.machineId).toBe(minted.machineId);
      // And a caller that *does* name one still wins, which is the reason the
      // argument takes precedence in the first place.
      expect(machineFilePath(home)).toBe(join(home, '.agbrte', 'machine.json'));
    } finally {
      if (previous === undefined) delete process.env['AGBRTE_HOME'];
      else process.env['AGBRTE_HOME'] = previous;
    }
  });

  it('is not derived from the hostname, which is reassigned and duplicated', async () => {
    const other = await mkdtemp(join(tmpdir(), 'agbrte-home2-'));
    try {
      const a = await machineIdentity(home);
      const b = await machineIdentity(other);
      // Same host, two install areas, two ids: the id names an *install*, and a
      // machine that has been wiped is a machine a client should not silently
      // recognise as the one it knew.
      expect(a.machineId).not.toBe(b.machineId);
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('replaces a malformed file rather than refusing to start', async () => {
    await mkdir(machineRoot(home), { recursive: true });
    await writeFile(machineFilePath(home), 'not json at all');

    const minted = await machineIdentity(home);

    expect(isUuid(minted.machineId)).toBe(true);
    // The opposite of `endpoints.json`'s rule and right for the opposite
    // reason: a broken endpoints file would misroute a turn, while a broken
    // machine file only means this machine has not been named yet.
    const written = JSON.parse(await readFile(machineFilePath(home), 'utf8')) as {
      machineId: string;
    };
    expect(written.machineId).toBe(minted.machineId);
  });
});

describe('the install area and a workspace share a name and nothing else', () => {
  it('keeps a workspace\'s data out of the machine\'s directory', async () => {
    const project = join(home, 'project');
    await mkdir(project, { recursive: true });

    // Same spelling, different directory — which is the whole arrangement.
    expect(workspaceLayout(project).dir).toBe(join(project, WORKSPACE_DIR));
    expect(workspaceLayout(project).dir).not.toBe(machineRoot(home));
  });

  it('refuses the one path where they would be the same folder', () => {
    // A workspace rooted at `$HOME` would put `sessions/` beside the private
    // Node and `instance.json` beside `endpoints.json`.
    expect(() => assertNotInstallRoot(home, home)).toThrow(/install directory/);
    expect(() => assertNotInstallRoot(join(home, 'project'), home)).not.toThrow();
  });
});
