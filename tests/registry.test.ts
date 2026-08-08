import { describe, expect, it } from 'vitest';
import { RuntimeRegistry, UnknownRuntimeError } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { newAgentId, type AgentSpec, type ToolPolicy } from '@shared/types/index.js';

const POLICY: ToolPolicy = { rules: [], defaultAction: 'ask' };

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    agentId: newAgentId(),
    role: 'worker',
    runtimeId: 'echo',
    auth: { kind: 'none' },
    toolPolicy: POLICY,
    limits: {},
    workspacePath: '/tmp/ws',
    ...over,
  };
}

function registryWith(runtime: EchoRuntime, requiresModel = false): RuntimeRegistry {
  const r = new RuntimeRegistry();
  r.register(runtime, { label: 'Echo', requiresModel });
  return r;
}

describe('RuntimeRegistry', () => {
  it('registers, describes, and lists runtimes', () => {
    const r = registryWith(new EchoRuntime());
    expect(r.has('echo')).toBe(true);
    expect(r.describe('echo').label).toBe('Echo');
    expect(r.list().map((d) => d.id)).toEqual(['echo']);
  });

  it('throws a named error for an unknown runtime', () => {
    const r = new RuntimeRegistry();
    expect(() => r.get('nope')).toThrow(UnknownRuntimeError);
  });

  describe('an id a runtime used to have', () => {
    /**
     * `runtimeId` is written into `session.json` and the event log, so renaming
     * a runtime does not rename what is already on disk. Without an alias, every
     * session created before the project was renamed from Gilmok fails to resume
     * with `no runtime registered` — against a log that is entirely intact.
     */
    it('resolves to the runtime that replaced it', async () => {
      const r = registryWith(new EchoRuntime({ id: 'agbrte-harness' }));
      r.alias('gilmok-harness', 'agbrte-harness');

      expect(r.has('gilmok-harness')).toBe(true);
      expect(r.get('gilmok-harness').id).toBe('agbrte-harness');
      const admitted = await r.admit(spec({ runtimeId: 'gilmok-harness' }), 'shared');
      expect(admitted.ok).toBe(true);
    });

    it('is not offered as something to choose', () => {
      const r = registryWith(new EchoRuntime({ id: 'agbrte-harness' }));
      r.alias('gilmok-harness', 'agbrte-harness');
      // A way in for old data, not a second runtime in the picker.
      expect(r.list().map((d) => d.id)).toEqual(['agbrte-harness']);
      expect(r.describe('gilmok-harness').id).toBe('agbrte-harness');
    });

    it('stays unknown when nothing replaced it', () => {
      const r = new RuntimeRegistry();
      r.alias('gilmok-harness', 'agbrte-harness');
      // An alias pointing at a runtime this host does not offer must not turn a
      // clear "not registered" into a confusing one.
      expect(r.has('gilmok-harness')).toBe(false);
      expect(() => r.get('gilmok-harness')).toThrow(UnknownRuntimeError);
    });
  });

  it('caches capabilities per model, not per runtime', async () => {
    let calls = 0;
    class Counting extends EchoRuntime {
      override async capabilities(s: AgentSpec) {
        calls += 1;
        return super.capabilities(s);
      }
    }
    const r = registryWith(new Counting(), true);

    const a = spec({ model: { providerId: 'p', modelId: 'small' } });
    const b = spec({ model: { providerId: 'p', modelId: 'large' } });

    await r.resolveCapabilities(a);
    await r.resolveCapabilities(a);
    expect(calls).toBe(1);

    // A different model is a different capability set (§3.2) — the cache must
    // not collapse them onto the runtime id.
    await r.resolveCapabilities(b);
    expect(calls).toBe(2);
  });

  it('invalidates cached capabilities, e.g. after a CLI upgrade', async () => {
    let calls = 0;
    class Counting extends EchoRuntime {
      override async capabilities(s: AgentSpec) {
        calls += 1;
        return super.capabilities(s);
      }
    }
    const r = registryWith(new Counting());
    await r.resolveCapabilities(spec());
    r.invalidateCapabilities('echo');
    await r.resolveCapabilities(spec());
    expect(calls).toBe(2);
  });
});

describe('admission', () => {
  it('admits a well-formed agent', async () => {
    const r = registryWith(new EchoRuntime());
    const result = await r.admit(spec(), 'shared');
    expect(result.ok).toBe(true);
  });

  it('refuses an all-or-nothing runtime under shared isolation', async () => {
    const r = registryWith(
      new EchoRuntime({ capabilities: { permissionFidelity: 'all-or-nothing' } }),
    );

    const shared = await r.admit(spec(), 'shared');
    expect(shared.ok).toBe(false);
    expect(shared.ok === false && shared.failures.map((f) => f.code)).toContain(
      'fidelity_requires_isolation',
    );

    // The same runtime is fine when the filesystem view is the boundary (§9).
    const worktree = await r.admit(spec(), 'worktree');
    expect(worktree.ok).toBe(true);
  });

  it('refuses a runtime below a role fidelity floor', async () => {
    const r = registryWith(
      new EchoRuntime({ capabilities: { permissionFidelity: 'precomputed-allowlist' } }),
    );
    const result = await r.admit(spec(), 'worktree', { minPermissionFidelity: 'callback' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failures[0]?.code).toBe('fidelity_below_floor');
    // The message must name what is missing, not just refuse (§4.2).
    expect(result.ok === false && result.failures[0]?.detail).toMatch(/callback.*precomputed-allowlist/);
  });

  it('accepts a fidelity above the floor', async () => {
    const r = registryWith(new EchoRuntime({ capabilities: { permissionFidelity: 'callback' } }));
    const result = await r.admit(spec(), 'shared', {
      minPermissionFidelity: 'precomputed-allowlist',
    });
    expect(result.ok).toBe(true);
  });

  it('names each missing capability rather than failing generically', async () => {
    const r = registryWith(
      new EchoRuntime({
        capabilities: {
          tools: 'text-protocol',
          subagents: false,
          interruptible: false,
          contextWindow: 8_000,
          input: { image: false, audio: false, pdf: false, video: false },
        },
      }),
    );

    const result = await r.admit(spec(), 'shared', {
      needsNativeTools: true,
      needsImageInput: true,
      needsSubagents: true,
      needsInterrupt: true,
      minContextWindow: 200_000,
    });

    expect(result.ok).toBe(false);
    const details = result.ok === false ? result.failures.map((f) => f.detail).join('\n') : '';
    expect(details).toMatch(/native tool calling/);
    expect(details).toMatch(/image input/);
    expect(details).toMatch(/subagents/);
    expect(details).toMatch(/interruption/);
    expect(details).toMatch(/context window/);
  });

  it('collects every failure in one pass', async () => {
    const r = registryWith(
      new EchoRuntime({ capabilities: { permissionFidelity: 'all-or-nothing', subagents: false } }),
      true,
    );
    // Missing model, wrong isolation for the fidelity, and a missing capability.
    const result = await r.admit(spec(), 'shared', { needsSubagents: true });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failures.length).toBeGreaterThanOrEqual(3);
  });

  it('requires a model when the runtime drives a provider', async () => {
    const r = registryWith(new EchoRuntime(), true);
    const result = await r.admit(spec(), 'worktree');
    expect(result.ok === false && result.failures.map((f) => f.code)).toContain('model_required');
  });

  it('rejects a model on a runtime that brings its own', async () => {
    const r = registryWith(new EchoRuntime(), false);
    const result = await r.admit(spec({ model: { providerId: 'p', modelId: 'm' } }), 'worktree');
    expect(result.ok === false && result.failures.map((f) => f.code)).toContain(
      'model_not_applicable',
    );
  });

  it('refuses a configuration that exceeds a cost ceiling', async () => {
    const r = registryWith(
      new EchoRuntime({
        capabilities: { pricing: { inputPerMTok: 5, outputPerMTok: 25, currency: 'USD' } },
      }),
    );
    const result = await r.admit(spec(), 'worktree', { maxCostPerMTokOut: 10 });
    expect(result.ok === false && result.failures[0]?.code).toBe('too_expensive');
  });

  it('reports a probe failure as an admission failure rather than throwing', async () => {
    const r = registryWith(new EchoRuntime({ capabilitiesError: 'endpoint unreachable' }));
    const result = await r.admit(spec(), 'shared');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failures[0]?.detail).toMatch(/endpoint unreachable/);
  });

  it('refuses an unregistered runtime by id', async () => {
    const r = new RuntimeRegistry();
    const result = await r.admit(spec(), 'shared');
    expect(result.ok === false && result.failures[0]?.code).toBe('unknown_runtime');
  });
});
