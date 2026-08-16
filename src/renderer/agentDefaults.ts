/**
 * The last agent choice that worked, remembered per host (§4.2, §10).
 *
 * A view preference, not session state: which runtime and model *this client*
 * reaches for first is a fact about the person at this keyboard, so it lives in
 * `localStorage` rather than in the session log or the workspace store. Another
 * device watching the same host is free to prefer something else.
 *
 * Keyed by `instanceId` because that is the fleet's primary key (§5.2) and the
 * question "is this choice still offerable" is a question about one host — the
 * runtimes and endpoints it reports are per machine.
 *
 * Every read revalidates against what the host says *now* (`resolveAgentDefault`),
 * so a stale entry degrades to the picker rather than to a wrong add.
 */

import type { HostInfo, RuntimeInfo } from '../shared/ipc/contract.js';

export interface AgentDefault {
  runtimeId: string;
  /** `null` when the runtime took no model — mirrors what `addAgent` was sent. */
  model: { providerId: string; modelId: string; endpointId?: string } | null;
}

const KEY = 'agbrte.agentDefaults.v1';

/** The whole map, tolerating a missing or corrupt store — both mean "no defaults". */
function readAll(): Record<string, AgentDefault> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, AgentDefault>;
  } catch {
    // Storage disabled, quota, or somebody edited the JSON by hand. A default
    // is a convenience; failing to load one must never cost more than typing.
    return {};
  }
}

export function loadAgentDefault(instanceId: string): AgentDefault | null {
  const entry = readAll()[instanceId];
  // Shape-checked because localStorage survives app versions and the value may
  // predate this shape. Anything malformed reads as "nothing remembered".
  if (entry === undefined || typeof entry !== 'object') return null;
  if (typeof entry.runtimeId !== 'string' || entry.runtimeId === '') return null;
  if (entry.model !== null) {
    if (typeof entry.model !== 'object') return null;
    if (typeof entry.model.modelId !== 'string') return null;
  }
  return entry;
}

export function saveAgentDefault(instanceId: string, choice: AgentDefault): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [instanceId]: choice }));
  } catch {
    // Not being able to remember is not an error worth a banner.
  }
}

/**
 * Whether a remembered choice is still offerable on this host, as the arguments
 * `addAgent` takes — or `null`, meaning: show the picker.
 *
 * This mirrors what `AgentPicker` itself enforces, no more. The picker never
 * requires the model to be in a listed catalogue — `/v1/models` is optional and
 * manual entry is a supported path — so neither does this. What it does check:
 *
 * - the runtime is among the ones this host reports;
 * - a runtime that *requires* a model has one remembered;
 * - a remembered endpoint still exists on the host. Gone means invalid, not
 *   "fall back to another endpoint": §13 forbids quietly changing where code
 *   is transmitted, and an automatic add against a substitute recipient is
 *   exactly that quiet change.
 */
export function resolveAgentDefault(
  choice: AgentDefault,
  runtimes: RuntimeInfo[],
  endpoints: HostInfo['endpoints'],
): { runtimeId: string; modelId: string | null; endpointId?: string } | null {
  const runtime = runtimes.find((r) => r.id === choice.runtimeId);
  if (runtime === undefined) return null;

  // The picker sends `null` for a no-model runtime whatever the field held, so a
  // remembered model is ignored the same way rather than treated as a mismatch.
  if (runtime.model === 'none') return { runtimeId: choice.runtimeId, modelId: null };

  if (choice.model === null) {
    // An optional-model runtime genuinely ran without one; a required-model
    // runtime with nothing remembered is not a choice the picker could make.
    return runtime.model === 'optional' ? { runtimeId: choice.runtimeId, modelId: null } : null;
  }

  const model = choice.model;
  if (model.modelId.trim() === '') return null;
  if (model.endpointId !== undefined) {
    if (!endpoints.some((e) => e.id === model.endpointId)) return null;
    return { runtimeId: choice.runtimeId, modelId: model.modelId, endpointId: model.endpointId };
  }
  return { runtimeId: choice.runtimeId, modelId: model.modelId };
}
