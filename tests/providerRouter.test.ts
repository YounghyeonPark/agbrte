/**
 * Routing an endpoint to its provider (DESIGN.md §3.6, §3.8, §15 Phase 3).
 *
 * `ModelEndpoint.providerId` has been on the record since §3.8 and nothing read
 * it: `buildHostRegistry` took one `ModelProvider` and every endpoint, whatever
 * it declared itself to be, was answered by that one adapter. Harmless with a
 * single implementation — there was nowhere else a request could go — and the
 * first thing the second implementation ran into.
 *
 * These are the tests for the field finally meaning something, and for the two
 * decisions the router makes that are not simple delegation: what happens to an
 * endpoint naming a provider nobody registered, and what happens when a caller
 * asks an adapter to count tokens that cannot.
 */

import { describe, expect, it } from 'vitest';
import { ProviderRouter } from '@main/runtime/providers/router.js';
import type {
  ModelDescriptor,
  ModelEndpoint,
  ModelProvider,
  ProviderRequest,
  ProviderResult,
  RuntimeCapabilities,
} from '@shared/types/index.js';

const CAPS = { tokenCounter: 'none' } as unknown as RuntimeCapabilities;

/** A provider that records nothing but its own name into every answer. */
function stub(id: string, opts: { counts?: boolean; describes?: boolean } = {}): ModelProvider {
  const provider: ModelProvider = {
    id,
    version: '1',
    listModels: () => Promise.resolve([{ modelId: `${id}-model` }] as ModelDescriptor[]),
    probe: () => Promise.resolve(CAPS),
    invoke: () =>
      Promise.resolve({
        content: [{ type: 'text', text: id }],
        toolCalls: [],
        stop: { kind: 'end_turn' },
        usage: { inputTokens: 0, outputTokens: 0 },
        raw: null,
      } as ProviderResult),
  };
  if (opts.describes === true) {
    provider.describe = (endpoint, modelId) =>
      Promise.resolve({ endpointId: endpoint.endpointId, modelId, tools: { value: 'native', from: 'configured' } });
  }
  if (opts.counts === true) provider.countTokens = () => Promise.resolve(42);
  return provider;
}

const endpoint = (providerId: string): ModelEndpoint => ({
  endpointId: `${providerId}-endpoint`,
  providerId,
  auth: { kind: 'none' },
  locality: 'cloud',
  dataHandling: { provider: providerId },
});

const request = (providerId: string): ProviderRequest => ({
  endpoint: endpoint(providerId),
  modelId: 'm',
  messages: [],
  maxOutputTokens: 100,
});

describe('which adapter answers', () => {
  it('sends an endpoint to the provider it names', async () => {
    const router = new ProviderRouter([stub('anthropic')], stub('openai-compatible'));

    // The whole point in one assertion: before this, both of these came back
    // from the fallback and the `providerId` on the record was decoration.
    expect((await router.listModels(endpoint('anthropic')))[0]?.modelId).toBe('anthropic-model');
    expect((await router.listModels(endpoint('openai-compatible')))[0]?.modelId).toBe(
      'openai-compatible-model',
    );
  });

  it('routes the request itself, not only the metadata', async () => {
    const router = new ProviderRouter([stub('anthropic')], stub('openai-compatible'));
    const result = await router.invoke(request('anthropic'), { signal: new AbortController().signal });
    // A router that picked correctly for listing and wrongly for invoking would
    // draw the right badge and then send the turn to the wrong API.
    expect(result.content).toEqual([{ type: 'text', text: 'anthropic' }]);
  });

  it('falls back rather than refusing an unknown provider id', async () => {
    const router = new ProviderRouter([stub('anthropic')], stub('openai-compatible'));

    /*
     * The old behaviour, kept deliberately. A typo in a `providerId` used to do
     * nothing at all, because nothing read the field; turning it into a session
     * that cannot start is how a compatibility change becomes an outage. The
     * fallback is named at construction, so a caller that wants a refusal can
     * pass one that refuses.
     */
    const models = await router.listModels(endpoint('typo-here'));
    expect(models[0]?.modelId).toBe('openai-compatible-model');
  });

  it('lists what it can route to', () => {
    const router = new ProviderRouter([stub('anthropic')], stub('openai-compatible'));
    expect(router.providerIds().sort()).toEqual(['anthropic', 'openai-compatible']);
  });
});

describe('describe, which not every adapter has', () => {
  it('delegates when the adapter can answer', async () => {
    const router = new ProviderRouter([stub('anthropic', { describes: true })], stub('fallback'));
    const hint = await router.describe(endpoint('anthropic'), 'm');
    expect(hint.tools).toEqual({ value: 'native', from: 'configured' });
  });

  it('returns the empty hint when it cannot, rather than throwing', async () => {
    const router = new ProviderRouter([stub('anthropic')], stub('fallback'));
    const hint = await router.describe(endpoint('anthropic'), 'm');

    // The interface's own answer for an adapter with nothing to read: an empty
    // hint, which the UI renders as *unknown* rather than as *no*. Those are
    // different sentences and only one of them is true.
    expect(hint).toEqual({ endpointId: 'anthropic-endpoint', modelId: 'm' });
  });
});

describe('counting tokens, where method presence is the wrong signal', () => {
  it('delegates to an adapter that counts', async () => {
    const router = new ProviderRouter([stub('anthropic', { counts: true })], stub('fallback'));
    expect(await router.countTokens(request('anthropic'))).toBe(42);
  });

  it('refuses by name for one that does not, instead of estimating', async () => {
    const router = new ProviderRouter([stub('anthropic', { counts: true })], stub('fallback'));

    /*
     * §3.6 is "provider-native counting only, never a foreign tokenizer", and
     * this is the seam where a foreign tokenizer would be tempting. Leaving the
     * method off the router would hide the native counter behind it; faking one
     * breaks the same rule from the other side. So it throws, and says which
     * field to read instead — `RuntimeCapabilities.tokenCounter` answers this
     * per endpoint, which method presence on a router cannot.
     */
    await expect(router.countTokens(request('fallback'))).rejects.toThrow(/tokenCounter/);
  });
});
