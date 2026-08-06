/**
 * Runtime registry and agent admission (DESIGN.md §3.2, §3.10, §4.2, §9).
 *
 * The registry resolves capabilities and refuses configurations that cannot be
 * run safely. Admission happens at agent *creation*, not at first tool call:
 * "an agent whose model can't clear the floor is refused at creation with the
 * specific missing capability named — not assigned and left to fail
 * confusingly three tool calls in" (§4.2).
 */

import type {
  AgentRuntime,
  AgentSpec,
  PermissionFidelity,
  RuntimeCapabilities,
} from '@shared/types/index.js';

export interface RuntimeDescriptor {
  id: string;
  label: string;
  /** `true` for GilmokHarness, which needs a ModelProvider to drive (§3.7). */
  requiresModel: boolean;
}

export type Isolation = 'shared' | 'worktree';

/** What a role demands of whatever fills it (§4.2). */
export interface RoleRequirements {
  needsNativeTools?: boolean;
  needsImageInput?: boolean;
  needsSubagents?: boolean;
  needsInterrupt?: boolean;
  minContextWindow?: number;
  minPermissionFidelity?: PermissionFidelity;
  maxCostPerMTokOut?: number;
}

export interface AdmissionFailure {
  code:
    | 'unknown_runtime'
    | 'model_required'
    | 'model_not_applicable'
    | 'fidelity_requires_isolation'
    | 'capability_missing'
    | 'context_window_too_small'
    | 'fidelity_below_floor'
    | 'too_expensive';
  detail: string;
}

export type Admission =
  | { ok: true; capabilities: RuntimeCapabilities }
  | { ok: false; failures: AdmissionFailure[] };

/** Strongest first. A floor is met by anything at or above it. */
const FIDELITY_RANK: Record<PermissionFidelity, number> = {
  callback: 3,
  'precomputed-allowlist': 2,
  'all-or-nothing': 1,
};

export class UnknownRuntimeError extends Error {
  constructor(id: string) {
    super(`no runtime registered with id "${id}"`);
    this.name = 'UnknownRuntimeError';
  }
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly descriptors = new Map<string, RuntimeDescriptor>();
  private readonly capCache = new Map<string, RuntimeCapabilities>();

  register(runtime: AgentRuntime, descriptor: Omit<RuntimeDescriptor, 'id'>): void {
    this.runtimes.set(runtime.id, runtime);
    this.descriptors.set(runtime.id, { id: runtime.id, ...descriptor });
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  get(id: string): AgentRuntime {
    const rt = this.runtimes.get(id);
    if (!rt) throw new UnknownRuntimeError(id);
    return rt;
  }

  describe(id: string): RuntimeDescriptor {
    const d = this.descriptors.get(id);
    if (!d) throw new UnknownRuntimeError(id);
    return d;
  }

  list(): RuntimeDescriptor[] {
    return [...this.descriptors.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Capabilities for a spec, cached per (runtime, model, endpoint).
   *
   * Cached — but keyed on the model, because capabilities belong to
   * adapter + model + installed version rather than to the adapter alone
   * (§3.2). Keying on runtimeId alone is the bug this signature prevents.
   */
  async resolveCapabilities(spec: AgentSpec): Promise<RuntimeCapabilities> {
    const key = capKey(spec);
    const hit = this.capCache.get(key);
    if (hit) return hit;

    const caps = await this.get(spec.runtimeId).capabilities(spec);
    this.capCache.set(key, caps);
    return caps;
  }

  /** Drop cached capabilities — after a vendor CLI upgrade, say. */
  invalidateCapabilities(runtimeId?: string): void {
    if (runtimeId === undefined) {
      this.capCache.clear();
      return;
    }
    for (const key of [...this.capCache.keys()]) {
      const [id] = JSON.parse(key) as string[];
      if (id === runtimeId) this.capCache.delete(key);
    }
  }

  /**
   * Decide whether an agent may be created. Collects *all* failures rather
   * than stopping at the first, so a misconfigured roster is fixed in one pass.
   */
  async admit(
    spec: AgentSpec,
    isolation: Isolation,
    requirements: RoleRequirements = {},
  ): Promise<Admission> {
    if (!this.has(spec.runtimeId)) {
      return {
        ok: false,
        failures: [{ code: 'unknown_runtime', detail: `runtime "${spec.runtimeId}" is not registered` }],
      };
    }

    const descriptor = this.describe(spec.runtimeId);
    const failures: AdmissionFailure[] = [];

    if (descriptor.requiresModel && !spec.model) {
      failures.push({
        code: 'model_required',
        detail: `${descriptor.id} drives a model provider, so spec.model is required`,
      });
    }
    if (!descriptor.requiresModel && spec.model) {
      failures.push({
        code: 'model_not_applicable',
        detail: `${descriptor.id} brings its own model plumbing; spec.model would be ignored`,
      });
    }

    // Capability probing can fail for reasons unrelated to admission (an
    // endpoint being down). Surface that as a failure rather than throwing.
    let caps: RuntimeCapabilities;
    try {
      caps = await this.resolveCapabilities(spec);
    } catch (err) {
      return {
        ok: false,
        failures: [
          ...failures,
          {
            code: 'capability_missing',
            detail: `could not resolve capabilities: ${(err as Error).message}`,
          },
        ],
      };
    }

    /**
     * The hard rule from §3.10 and §9: if nothing gates the individual calls,
     * the filesystem view must. Checked here — at creation — because
     * discovering it at the first tool call means the agent is already running
     * unsupervised in a shared workspace.
     */
    if (caps.permissionFidelity === 'all-or-nothing' && isolation === 'shared') {
      failures.push({
        code: 'fidelity_requires_isolation',
        detail:
          `${descriptor.id} reports permissionFidelity "all-or-nothing", so it may only run ` +
          `with worktree or container isolation — never "shared"`,
      });
    }

    if (
      requirements.minPermissionFidelity &&
      FIDELITY_RANK[caps.permissionFidelity] < FIDELITY_RANK[requirements.minPermissionFidelity]
    ) {
      failures.push({
        code: 'fidelity_below_floor',
        detail:
          `role requires permissionFidelity at least "${requirements.minPermissionFidelity}" ` +
          `but ${descriptor.id} reports "${caps.permissionFidelity}"`,
      });
    }

    if (requirements.needsNativeTools && caps.tools !== 'native') {
      failures.push({
        code: 'capability_missing',
        detail: `role requires native tool calling but ${descriptor.id} reports tools="${caps.tools}"`,
      });
    }
    if (requirements.needsImageInput && !caps.input.image) {
      failures.push({
        code: 'capability_missing',
        detail: `role requires image input but ${descriptor.id} does not support it`,
      });
    }
    if (requirements.needsSubagents && !caps.subagents) {
      failures.push({
        code: 'capability_missing',
        detail: `role requires subagents but ${descriptor.id} does not support them`,
      });
    }
    if (requirements.needsInterrupt && !caps.interruptible) {
      failures.push({
        code: 'capability_missing',
        detail: `role requires interruption but ${descriptor.id} is not interruptible`,
      });
    }
    if (
      requirements.minContextWindow !== undefined &&
      caps.contextWindow < requirements.minContextWindow
    ) {
      failures.push({
        code: 'context_window_too_small',
        detail:
          `role requires a context window of at least ${requirements.minContextWindow} ` +
          `but ${descriptor.id} reports ${caps.contextWindow}`,
      });
    }
    if (
      requirements.maxCostPerMTokOut !== undefined &&
      typeof caps.pricing === 'object' &&
      caps.pricing.outputPerMTok > requirements.maxCostPerMTokOut
    ) {
      failures.push({
        code: 'too_expensive',
        detail:
          `role caps output cost at ${requirements.maxCostPerMTokOut}/MTok ` +
          `but this configuration is ${caps.pricing.outputPerMTok}/MTok`,
      });
    }

    return failures.length === 0 ? { ok: true, capabilities: caps } : { ok: false, failures };
  }
}

function capKey(spec: AgentSpec): string {
  // JSON rather than a delimiter: no separator can collide with a provider or
  // model id, and the key stays printable. An earlier version used a raw NUL,
  // which made this file binary to git and invisible in diffs.
  return JSON.stringify([
    spec.runtimeId,
    spec.model?.providerId ?? '',
    spec.model?.modelId ?? '',
    spec.model?.endpointId ?? '',
  ]);
}
