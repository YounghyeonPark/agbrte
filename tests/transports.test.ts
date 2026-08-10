/**
 * Which localities exist, and what an unbuilt one does (DESIGN.md §6.1, §6.2).
 *
 * The bug these exist for made nothing fail. `ExecutionTarget` names eight
 * kinds, two work, and the app's connector was
 *
 *     if (target.kind === 'ssh') { …remote… }
 *     return connectOrSpawnHost(…)
 *
 * so the other six ran **on the user's own machine**, successfully, under a
 * badge saying `docker:…` or `wsl:ubuntu`. There is no test that could have
 * caught that by asserting on an outcome, because the outcome was a working
 * session — which is why the assertion here is about *refusal* rather than about
 * behaviour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fleet } from '@main/fleet.js';
import {
  requireTransport,
  supportedTargetKinds,
  transportFor,
  TransportUnsupported,
  TRANSPORTS,
} from '@main/host/transports.js';
import type { ExecutionTarget, TargetKind } from '@shared/types/index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** One of each kind, so the table can be walked rather than sampled. */
const EXAMPLES: Record<TargetKind, ExecutionTarget> = {
  local: { kind: 'local' },
  ssh: { kind: 'ssh', host: 'build-01' },
  wsl: { kind: 'wsl', distro: 'ubuntu' },
  container: { kind: 'container', engine: 'docker', containerId: 'abc123def456' },
  k8s: { kind: 'k8s', context: 'prod', namespace: 'agents', pod: 'runner-0' },
  devcontainer: { kind: 'devcontainer', configPath: '/w/.devcontainer.json' },
  hosted: { kind: 'hosted', serviceId: 'svc', agentRef: 'a1' },
  custom: { kind: 'custom', transportId: 'mine', config: {} },
};

describe('the table covers every locality', () => {
  it('has a row for each kind, and each row is about that kind', () => {
    // `Record<TargetKind, …>` makes a missing row a compile error, so this is
    // the runtime half: a row that was copy-pasted and left naming its neighbour
    // still typechecks, and would send someone to the wrong section.
    for (const kind of Object.keys(EXAMPLES) as TargetKind[]) {
      expect(TRANSPORTS[kind], `no row for ${kind}`).toBeDefined();
      expect(TRANSPORTS[kind].kind).toBe(kind);
      expect(TRANSPORTS[kind].label).not.toBe('');
    }
  });

  it('claims to have observed only what has actually run', () => {
    /**
     * The distinction the table exists to keep. Two rows were measured against a
     * real host; six were read out of documentation. A table that mixes them is
     * one nobody can trust a row of — and the temptation to promote a row while
     * writing the transport, rather than after running it, is exactly why this
     * is asserted rather than commented.
     */
    const observed = (Object.keys(TRANSPORTS) as TargetKind[]).filter(
      (k) => TRANSPORTS[k].evidence === 'observed',
    );
    expect(observed.sort()).toEqual(['local', 'ssh']);
    // And the two are the same two that work. A row cannot be observed without
    // being implemented, because there was nothing to observe.
    expect(supportedTargetKinds().sort()).toEqual(observed.sort());
  });

  it('says why, whenever it says no', () => {
    for (const kind of Object.keys(TRANSPORTS) as TargetKind[]) {
      const reason = TRANSPORTS[kind].unimplemented;
      if (reason === null) continue;
      // The sentence is the whole of what the user gets — there is no fallback
      // behind it — so an empty or bare-minimum one is a real defect.
      expect(reason.length, `${kind} refuses without explaining`).toBeGreaterThan(30);
      expect(reason, `${kind} does not name itself`).toMatch(
        new RegExp(kind === 'k8s' ? 'Kubernetes' : kind, 'i'),
      );
    }
  });

  it('does not claim a capability the transport does not exist to have', () => {
    // A row is a promise about a mechanism, not about an implementation — but
    // `custom` has no mechanism at all until a plugin registers one, so the
    // conservative row is the only honest one. Assuming a capability a plugin
    // lacks fails at the worst moment: mid-run, on the remote side.
    const custom = TRANSPORTS.custom.capabilities;
    expect(custom.persistentProcesses).toBe(false);
    expect(custom.unixSockets).toBe(false);
    expect(custom.fileTransfer).toBe(false);
  });

  it('records the unix socket as the reason the next transports are not a runner swap', () => {
    /**
     * The finding this table was written to hold onto. `SshRunner` is
     * `exec`/`upload`/`forward`, and the first two are nearly free for WSL or a
     * container. `forward` is not: the host listens on a unix socket, and none
     * of these can carry one out. §6.1 already names the fallback — a loopback
     * control port plus a bearer token — and it does not exist, so "not written
     * yet" is the wrong description of all four.
     */
    for (const kind of ['wsl', 'container', 'k8s', 'devcontainer'] as const) {
      expect(TRANSPORTS[kind].capabilities.unixSockets, kind).toBe(false);
    }
    // Both working transports have one, which is why nothing has needed the
    // fallback and why it was never noticed missing.
    expect(TRANSPORTS.local.capabilities.unixSockets).toBe(true);
    expect(TRANSPORTS.ssh.capabilities.unixSockets).toBe(true);
  });
});

describe('an unbuilt locality is refused, not redirected', () => {
  it('lets the two that work through', () => {
    expect(requireTransport({ kind: 'local' }).kind).toBe('local');
    expect(requireTransport({ kind: 'ssh', host: 'build-01' }).kind).toBe('ssh');
  });

  it('refuses each of the six by name', () => {
    for (const kind of Object.keys(EXAMPLES) as TargetKind[]) {
      if (TRANSPORTS[kind].unimplemented === null) continue;
      try {
        requireTransport(EXAMPLES[kind]);
        expect.unreachable(`${kind} was accepted`);
      } catch (err) {
        expect(err).toBeInstanceOf(TransportUnsupported);
        // The kind is carried structurally as well as in the sentence, so a
        // caller can branch on it without parsing prose.
        expect((err as TransportUnsupported).kind).toBe(kind);
      }
    }
  });

  it('never reaches the connector — which is the whole bug', async () => {
    /**
     * The assertion that would have caught it. Before the gate, asking for a
     * container called the connector, which fell through to the local branch and
     * started a host **here**: a real session, a real transcript, a badge saying
     * `docker:abc123def456`, and no error anywhere.
     *
     * So this asserts on the connector never being called rather than on the
     * error, because the error is easy and the silent local run is the failure.
     */
    const connect = vi.fn();
    const fleet = new Fleet({ connect, runtimes: [] });
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agbrte-transport-'));
    roots.push(workspaceRoot);

    const outcomes = new Map<TargetKind, unknown>();
    for (const kind of Object.keys(EXAMPLES) as TargetKind[]) {
      if (TRANSPORTS[kind].unimplemented === null) continue;
      outcomes.set(
        kind,
        await fleet.attach({ target: EXAMPLES[kind], workspaceRoot }).catch((e: unknown) => e),
      );
    }

    // Asserted *before* the per-kind check, and collected rather than thrown
    // above, because the first version put this last and removing the gate made
    // an earlier assertion fail first — so the sentence naming the actual bug
    // never ran. A test whose load-bearing line is unreachable on failure is
    // documentation.
    expect(connect, 'a transport nobody implemented was dialled anyway').not.toHaveBeenCalled();

    for (const [kind, outcome] of outcomes) {
      expect(outcome, `${kind} was not refused`).toBeInstanceOf(TransportUnsupported);
    }
  });

  it('carries the sentence a user reads, not ssh’s or docker’s', async () => {
    const fleet = new Fleet({ connect: vi.fn(), runtimes: [] });
    await expect(
      fleet.attach({ target: EXAMPLES.wsl, workspaceRoot: '/w' }),
    ).rejects.toThrow(/unix socket/);
  });
});

describe('transportFor answers for anything', () => {
  it('describes a locality without deciding whether to use it', () => {
    // Separate from `requireTransport` because the UI needs to *show* a kind it
    // will not attach — §6.9's "the reduced matrix must be visible in the UI,
    // not discovered".
    expect(transportFor(EXAMPLES.hosted).label).toContain('hosted');
    expect(transportFor(EXAMPLES.hosted).unimplemented).not.toBeNull();
  });
});
