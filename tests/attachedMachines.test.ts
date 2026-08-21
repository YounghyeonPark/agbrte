/**
 * Coming back to the machines this app was attached to (DESIGN.md §6.4, §8).
 *
 * Quitting disconnects and does not stop, so a remote host is still running
 * when the window returns — and until this existed, still invisible: startup
 * attached local workspaces and nothing else, so a build box holding a live
 * session sat there unlisted until somebody pressed **Attach** again.
 *
 * Two halves, tested apart because they fail apart. The *list* is a file in the
 * machine directory, written when an attach worked and cleared when a person
 * removes the host. The *reaching* is a bounded retry that must never block a
 * window and must not re-dial a machine that has refused.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachedMachinesPath,
  forgetMachine,
  readAttachedMachines,
  rememberMachine,
} from '@main/attachedMachines.js';
import { MachineRestorer } from '@main/restoreMachines.js';
import type { Fleet } from '@main/fleet.js';
import { createApi } from '@main/ipc/api.js';
import { CH } from '@shared/ipc/contract.js';

let home: string;
let previous: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agbrte-attached-'));
  // The module reads `machineRoot()`, which is the installation this process
  // belongs to — so the test moves the installation rather than passing a path
  // to some calls and not to others (see `machine.ts`).
  previous = process.env['AGBRTE_HOME'];
  process.env['AGBRTE_HOME'] = join(home, '.agbrte');
});

afterEach(async () => {
  if (previous === undefined) delete process.env['AGBRTE_HOME'];
  else process.env['AGBRTE_HOME'] = previous;
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('the machines to reach for next time', () => {
  it('remembers a destination once, however many times it is attached', async () => {
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/work' });
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/work' });

    expect(await readAttachedMachines()).toEqual([
      { alias: 'build-01', workspaceRoot: '/srv/work' },
    ]);
  });

  it('keys on the folder too, because one machine holds several projects', async () => {
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/one' });
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/two' });

    expect(await readAttachedMachines()).toHaveLength(2);

    // Removing one host is not removing the other.
    await forgetMachine({ alias: 'build-01', workspaceRoot: '/srv/one' });
    expect(await readAttachedMachines()).toEqual([
      { alias: 'build-01', workspaceRoot: '/srv/two' },
    ]);
  });

  it('is unreadable rather than fatal, like every other hint (§6.4)', async () => {
    await mkdir(join(home, '.agbrte'), { recursive: true });
    await writeFile(attachedMachinesPath(), 'not json at all', 'utf8');

    // A list of shortcuts that cannot be parsed must not stop an app starting.
    expect(await readAttachedMachines()).toEqual([]);
  });

  it('holds no secret: an alias is a name in a config the user already owns', async () => {
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/work' });
    const raw = await readFile(attachedMachinesPath(), 'utf8');

    // Stated as a test because the file is new and the rule is easy to break
    // later: everything needed to connect stays in the ssh config (§6.2).
    expect(raw).toContain('build-01');
    expect(raw).not.toMatch(/password|token|key|secret/i);
  });
});

describe('the two acts that change the list', () => {
  /**
   * The wiring, pinned because the wiring is where this can go wrong quietly.
   *
   * Remembering belongs to the *app* and not to `Fleet` — the CLI attaches what
   * its argv names and must not inherit a list somebody's window wrote — so it
   * lives at these two handlers, and a unit test of the file below would keep
   * passing if either one were dropped.
   */
  function apiWith(fleet: Partial<Fleet>): ReturnType<typeof createApi> {
    return createApi({
      fleet: fleet as Fleet,
      runtimes: [],
      loadConformance: async () => null,
      broadcast: () => undefined,
    });
  }

  it('remembers a machine when attaching it worked', async () => {
    const api = apiWith({
      // Enough of an attached host for `toInfo` to describe: the handler
      // answers with one, and what is under test is what it wrote on the way.
      attach: async () =>
        ({
          instanceId: 'i1',
          lineageId: 'l1',
          workspaceRoot: '/srv/work',
          target: { kind: 'ssh', alias: 'build-01', host: 'build-01' },
          available: [],
          endpoints: [],
          runtimeNotes: [],
          role: 'read-write',
          link: 'connected',
          sessions: [],
        }) as unknown as Awaited<ReturnType<Fleet['attach']>>,
      hosts: () => [],
      on: () => undefined as never,
      off: () => undefined as never,
    });

    await api.handlers.get(CH.hostsAddRemote)!('build-01', '/srv/work');
    // Written after the attach returned, so a dial that failed leaves nothing
    // for the next launch to chase.
    await vi.waitFor(async () => expect(await readAttachedMachines()).toHaveLength(1));
  });

  it('forgets it when a person removes the host', async () => {
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/work' });
    let detached = '';
    const api = apiWith({
      hosts: () =>
        [
          {
            instanceId: 'i1',
            workspaceRoot: '/srv/work',
            target: { kind: 'ssh', alias: 'build-01', host: 'build-01' },
          },
        ] as unknown as ReturnType<Fleet['hosts']>,
      detach: async (id: string) => {
        detached = id;
      },
      on: () => undefined as never,
      off: () => undefined as never,
    });

    await api.handlers.get(CH.hostsRemove)!('i1');

    expect(detached).toBe('i1');
    expect(await readAttachedMachines()).toEqual([]);
  });

  it('leaves the list alone when the host removed was local', async () => {
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/work' });
    const api = apiWith({
      hosts: () =>
        [
          { instanceId: 'i2', workspaceRoot: '/home/me/proj', target: { kind: 'local' } },
        ] as unknown as ReturnType<Fleet['hosts']>,
      detach: async () => undefined,
      on: () => undefined as never,
      off: () => undefined as never,
    });

    await api.handlers.get(CH.hostsRemove)!('i2');

    // This machine is attached by construction and was never in the list; a
    // removal that emptied it would lose a remote nobody touched.
    expect(await readAttachedMachines()).toHaveLength(1);
  });
});

/** A fleet that answers however the test says, and counts the dials. */
function fakeFleet(answers: Array<Error | 'ok'>): {
  fleet: Pick<Fleet, 'attach'>;
  dials: () => number;
} {
  let i = 0;
  return {
    dials: () => i,
    fleet: {
      attach: async () => {
        const answer = answers[Math.min(i, answers.length - 1)];
        i += 1;
        if (answer instanceof Error) throw answer;
        return {} as Awaited<ReturnType<Fleet['attach']>>;
      },
    },
  };
}

describe('reaching for them at startup', () => {
  /** No real waiting: the backoff is the thing under test, not the clock. */
  const instant = async (): Promise<void> => undefined;

  it('keeps trying a machine that is still booting', async () => {
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/work' });
    const { fleet, dials } = fakeFleet([new Error('connect ETIMEDOUT'), 'ok']);
    const restorer = new MachineRestorer(fleet, instant);

    await restorer.start();

    expect(dials()).toBe(2);
    expect(restorer.restoring()).toEqual([
      { alias: 'build-01', workspaceRoot: '/srv/work', state: 'attached', attempts: 2 },
    ]);
  });

  it('stops at a refusal, which will say the same thing in thirty seconds', async () => {
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/work' });
    const refusal = new Error('this client is too old for that host');
    refusal.name = 'ClientTooOld';
    const { fleet, dials } = fakeFleet([refusal]);
    const restorer = new MachineRestorer(fleet, instant);

    await restorer.start();

    // Once. Re-dialling a stated fact is noise in somebody else's sshd log.
    expect(dials()).toBe(1);
    expect(restorer.restoring()[0]?.state).toBe('refused');
    expect(restorer.restoring()[0]?.detail).toMatch(/too old/);
  });

  it('gives up on a machine that is not there, and says which', async () => {
    await rememberMachine({ alias: 'off-01', workspaceRoot: '/srv/work' });
    const { fleet, dials } = fakeFleet([new Error('ssh: connect to host off-01 port 22: down')]);
    const restorer = new MachineRestorer(fleet, instant);

    await restorer.start();

    expect(dials()).toBe(5);
    const [state] = restorer.restoring();
    expect(state?.state).toBe('unreachable');
    expect(state?.detail).toMatch(/off-01/);
    // Kept, not forgotten: a box that is off today is the same box tomorrow, and
    // the only thing that forgets one is a person removing the host.
    expect(await readAttachedMachines()).toHaveLength(1);
  });

  it('does not let one machine that is off delay one that is on', async () => {
    await rememberMachine({ alias: 'off-01', workspaceRoot: '/srv/a' });
    await rememberMachine({ alias: 'up-01', workspaceRoot: '/srv/b' });

    const order: string[] = [];
    const restorer = new MachineRestorer(
      {
        attach: async (location) => {
          const alias = location.target.kind === 'ssh' ? (location.target.alias ?? '') : 'local';
          order.push(alias);
          if (alias === 'off-01') throw new Error('down');
          return {} as Awaited<ReturnType<Fleet['attach']>>;
        },
      },
      (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    );

    await restorer.start();

    // The machine that is up was dialled before the one that is off ran out of
    // attempts, which a sequential loop over the list could not do.
    expect(order.indexOf('up-01')).toBeLessThan(order.lastIndexOf('off-01'));
  });

  it('stops scheduling when the app is quitting', async () => {
    await rememberMachine({ alias: 'build-01', workspaceRoot: '/srv/work' });
    const { fleet, dials } = fakeFleet([new Error('down')]);
    const restorer: MachineRestorer = new MachineRestorer(fleet, async () => {
      restorer.dispose();
    });

    await restorer.start();

    // One dial, then the app quit. A pending retry must not outlive the window
    // it was started for.
    expect(dials()).toBe(1);
  });
});
