/**
 * The client half of remote discovery (DESIGN.md §6.2, §10).
 *
 * `tests/discoverWorkspaces.test.ts` covers what is sent to a machine and what
 * comes back. This covers what the app does with it: which answer is held, which
 * is thrown away, and what is remembered so that the second attach to a familiar
 * machine is one click.
 *
 * Driven against the store and the preference module directly, with a stubbed
 * `window.agbrte` — the same seam the renderer uses in the browser. The DOM half
 * is `tests/e2e/attach.spec.ts`, which drives the real panel in the real app
 * with the main-process handler stubbed; neither is a substitute for the other,
 * and neither can measure the live ssh path on a machine with no `sshd`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useAgbrte } from '../src/renderer/store.js';
import {
  autoDiscoverDelay,
  isPlausibleAlias,
  TYPED_DEBOUNCE_MS,
} from '../src/renderer/attachTrigger.js';
import {
  loadLastAlias,
  loadLastWorkspace,
  rememberRemoteWorkspace,
} from '../src/renderer/remoteWorkspaces.js';
import type { WorkspaceDiscoveryDto } from '../src/shared/ipc/contract.js';

/** The smallest `localStorage` the preference module can be honest against. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

const found: WorkspaceDiscoveryDto = {
  alias: 'build-01',
  roots: ['/home/dev', '/home/dev/src', '/srv'],
  depth: 3,
  candidates: [
    { path: '/home/dev/agbrte', kind: 'devagents' },
    { path: '/home/dev/src/api', kind: 'git' },
    { path: '/home/dev/Documents', kind: 'folder' },
  ],
  truncated: false,
  partial: false,
};

/** Installs a `window.agbrte` whose discovery is whatever this test wants. */
function stubApi(discover: (alias: string) => Promise<WorkspaceDiscoveryDto>): {
  asked: string[];
} {
  const asked: string[] = [];
  (globalThis as { window?: unknown }).window = {
    agbrte: {
      hosts: {
        discoverWorkspaces: (alias: string) => {
          asked.push(alias);
          return discover(alias);
        },
        addRemote: async () => ({ instanceId: 'i1' }),
      },
    },
  };
  return { asked };
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
  useAgbrte.setState({ discovery: null, error: null, busy: false });
});

describe('asking a machine what is on it', () => {
  it('holds the answer, and holds which machine it is about', async () => {
    const { asked } = stubApi(async () => found);
    await useAgbrte.getState().discoverWorkspaces('build-01');

    const state = useAgbrte.getState();
    expect(asked).toEqual(['build-01']);
    expect(state.discovery?.alias).toBe('build-01');
    expect(state.discovery?.phase).toBe('done');
    expect(state.discovery?.result?.candidates).toHaveLength(3);
    // The roots travel with the result: a UI that shows an empty list without
    // them is showing something indistinguishable from a broken feature.
    expect(state.discovery?.result?.roots).toEqual(['/home/dev', '/home/dev/src', '/srv']);
  });

  it('drops a previous machine’s answer rather than leaving it on screen', async () => {
    stubApi(async () => found);
    await useAgbrte.getState().discoverWorkspaces('build-01');
    useAgbrte.getState().clearDiscovery();
    expect(useAgbrte.getState().discovery).toBeNull();
  });

  it('keeps an unreachable machine out of the app-wide error banner', async () => {
    /*
     * The property the automatic trigger makes load-bearing. Nobody pressed
     * anything to cause this search, so a sleeping build box must not throw a
     * red banner across the window: that is an alarm about an action the user
     * did not take, over a field that still works perfectly well by hand.
     */
    stubApi(async () => {
      throw new Error('The machine refused the credentials this computer offered.');
    });
    await useAgbrte.getState().discoverWorkspaces('locked');

    const state = useAgbrte.getState();
    expect(state.error).toBeNull();
    // Carried inline instead, with the machine named, because by the time it
    // arrives the field may say something else.
    expect(state.discovery?.phase).toBe('failed');
    expect(state.discovery?.alias).toBe('locked');
    expect(state.discovery?.error).toContain('refused the credentials');
  });

  it('says which machine it is looking on, from the moment it starts', async () => {
    let release = (): void => undefined;
    stubApi(
      async () =>
        new Promise<WorkspaceDiscoveryDto>((resolve) => {
          release = () => resolve(found);
        }),
    );
    const pending = useAgbrte.getState().discoverWorkspaces('build-01');
    // Set synchronously: one bounded command can take twenty seconds against a
    // machine over a slow link, and a still panel for twenty seconds reads as a
    // hang.
    expect(useAgbrte.getState().discovery).toEqual({
      alias: 'build-01',
      phase: 'looking',
      result: null,
      error: null,
    });
    release();
    await pending;
    expect(useAgbrte.getState().discovery?.phase).toBe('done');
  });

  it('lets the last machine win, so a slow answer cannot land under a new name', async () => {
    // The one failure mode an automatic search adds that a button never had: the
    // user moves on while the first machine is still thinking.
    const gates = new Map<string, (dto: WorkspaceDiscoveryDto) => void>();
    stubApi(
      async (alias) => new Promise<WorkspaceDiscoveryDto>((resolve) => gates.set(alias, resolve)),
    );

    const slow = useAgbrte.getState().discoverWorkspaces('slow-01');
    const quick = useAgbrte.getState().discoverWorkspaces('quick-02');
    gates.get('quick-02')!({ ...found, alias: 'quick-02', candidates: [] });
    await quick;
    // ...and only now does the machine that was asked first answer.
    gates.get('slow-01')!({ ...found, alias: 'slow-01' });
    await slow;

    expect(useAgbrte.getState().discovery?.alias).toBe('quick-02');
    expect(useAgbrte.getState().discovery?.result?.candidates).toEqual([]);
  });

  it('drops the answer to a search the panel has closed on', async () => {
    let release = (): void => undefined;
    stubApi(
      async () =>
        new Promise<WorkspaceDiscoveryDto>((resolve) => {
          release = () => resolve(found);
        }),
    );
    const pending = useAgbrte.getState().discoverWorkspaces('build-01');
    // Closing the panel. There is no cancel to send — one bounded, read-only
    // command with its own kill on the far side — so what is cancelled is the
    // answer.
    useAgbrte.getState().clearDiscovery();
    release();
    await pending;
    expect(useAgbrte.getState().discovery).toBeNull();
  });

  it('keeps a machine that cannot be listed out of the error banner', async () => {
    // A Windows remote answered perfectly well. Nothing failed, so nothing is
    // reported as a failure — the sentence rides on the result instead.
    stubApi(async () => ({
      alias: 'winbox',
      roots: [],
      depth: 3,
      candidates: [],
      truncated: false,
      partial: false,
      unavailable: 'winbox is a Windows machine, and looking around one is not built yet',
    }));
    await useAgbrte.getState().discoverWorkspaces('winbox');

    expect(useAgbrte.getState().error).toBeNull();
    expect(useAgbrte.getState().discovery?.phase).toBe('done');
    expect(useAgbrte.getState().discovery?.result?.unavailable).toContain('Windows');
  });
});

describe('when the app goes and looks on its own', () => {
  it('waits for nothing when the name came from the user\u2019s own config', () => {
    // Choosing `build-01` from the list is unambiguous: that name is a machine,
    // the user said so, and a delay after it would be lag for its own sake.
    expect(autoDiscoverDelay('build-01', ['build-01', 'laptop'])).toBe(0);
  });

  it('waits for the typing to stop when the name is being spelled out', () => {
    // `user@10.0.0.9` passes through nine prefixes that are not machines, and
    // firing on each would open nine connections to nothing.
    expect(autoDiscoverDelay('user@10.0.0.9', ['build-01'])).toBe(TYPED_DEBOUNCE_MS);
    expect(autoDiscoverDelay('build-0', ['build-01'])).toBe(TYPED_DEBOUNCE_MS);
  });

  it('never fires for something that could not be a destination', () => {
    // `ssh -oProxyCommand=... host` runs a command on *this* machine. Main
    // refuses it too; this stops it from becoming a rejected promise nobody
    // asked for.
    expect(autoDiscoverDelay('-oProxyCommand=calc', [])).toBeNull();
    expect(autoDiscoverDelay('   ', [])).toBeNull();
    expect(autoDiscoverDelay('two words', [])).toBeNull();
    expect(isPlausibleAlias('build-01')).toBe(true);
  });
});

describe('what this client remembers about a machine', () => {
  it('offers the path that last worked there, per machine', () => {
    rememberRemoteWorkspace('build-01', '/srv/app');
    rememberRemoteWorkspace('laptop', '/home/dev/notes');

    expect(loadLastWorkspace('build-01')).toBe('/srv/app');
    expect(loadLastWorkspace('laptop')).toBe('/home/dev/notes');
    // A machine never attached has nothing to offer, which is a picker rather
    // than a wrong prefill.
    expect(loadLastWorkspace('somewhere-else')).toBeNull();
    // And the machine itself, so the panel opens where it was left.
    expect(loadLastAlias()).toBe('laptop');
  });

  it('survives a store that has been edited by hand', () => {
    localStorage.setItem('agbrte.remoteWorkspaces.v1', '{not json');
    expect(loadLastWorkspace('build-01')).toBeNull();
    expect(loadLastAlias()).toBeNull();
    // …and writing over the wreckage still works.
    rememberRemoteWorkspace('build-01', '/srv/app');
    expect(loadLastWorkspace('build-01')).toBe('/srv/app');
  });

  it('refuses to remember nothing', () => {
    rememberRemoteWorkspace('build-01', '   ');
    expect(loadLastWorkspace('build-01')).toBeNull();
  });
});
