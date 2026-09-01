/**
 * One `ModelProvider` over several (DESIGN.md §3.6, §3.8, §15 Phase 3).
 *
 * ## Why this had to exist before a second provider could
 *
 * `ModelEndpoint.providerId` has been on the record since §3.8 was written, and
 * **nothing read it**. `buildRegistry` takes one `ModelProvider` and hands it to
 * the harness; every endpoint, whatever it claimed to be, was answered by that
 * one adapter. With a single implementation that is invisible and harmless —
 * there is nowhere else a request could have gone.
 *
 * It is the first thing the second implementation ran into, and it is exactly
 * what §15 means by "an abstraction validated against one implementation is not
 * validated". The interface was fine. The *wiring* had quietly assumed there
 * would only ever be one, in a field whose entire purpose is to say which.
 *
 * ## Why a `ModelProvider` rather than a change to the harness
 *
 * `AgbrteHarnessRuntime` keeps taking one provider, and the one it takes is this.
 * That preserves the property `buildRegistry` documents and would otherwise have
 * lost: the *same instance* answers the picker's "what can this model do" and the
 * run that follows, so a probe cache is shared and two inference requests do not
 * get spent producing two answers that can disagree. A router that dispatches
 * per call keeps every adapter's cache intact behind it, because it holds the
 * adapters rather than making them.
 *
 * ## The fallback is the old behaviour, deliberately
 *
 * An endpoint naming a provider nobody registered is answered by
 * `openai-compatible`, which is what happened to every endpoint before this
 * existed. Refusing instead would turn a typo in a `providerId` into a session
 * that cannot start, and that shape — a field nothing validated suddenly being
 * load-bearing — is how a compatibility change becomes an outage. The fallback
 * is named at construction rather than assumed here, so a caller that wants a
 * refusal can pass one that refuses.
 */

import type {
  ModelCapabilityHint,
  ModelDescriptor,
  ModelEndpoint,
  ModelProvider,
  ProviderRequest,
  ProviderResult,
  RuntimeCapabilities,
} from '@shared/types/index.js';

export class ProviderRouter implements ModelProvider {
  readonly id = 'router';
  readonly version = '0.0.1';

  private readonly byId = new Map<string, ModelProvider>();

  constructor(
    providers: ModelProvider[],
    /** Answers an endpoint naming a provider nobody registered. */
    private readonly fallback: ModelProvider,
  ) {
    for (const provider of providers) this.byId.set(provider.id, provider);
    this.byId.set(fallback.id, fallback);
  }

  /** Which adapter owns this endpoint. The one thing this class is for. */
  private pick(endpoint: ModelEndpoint): ModelProvider {
    return this.byId.get(endpoint.providerId) ?? this.fallback;
  }

  /** Which adapters are registered, for a caller that wants to say so. */
  providerIds(): string[] {
    return [...this.byId.keys()];
  }

  listModels(endpoint: ModelEndpoint): Promise<ModelDescriptor[]> {
    return this.pick(endpoint).listModels(endpoint);
  }

  probe(endpoint: ModelEndpoint, modelId: string): Promise<RuntimeCapabilities> {
    return this.pick(endpoint).probe(endpoint, modelId);
  }

  /**
   * Delegated, with the interface's own answer for an adapter that has none.
   *
   * `describe` is optional because some adapters have nothing to read, and the
   * documented behaviour for that is an **empty hint** — which the UI renders as
   * *unknown* rather than as *no*. So the router always defines the method and
   * returns the empty hint when the adapter behind it does not, which is the same
   * sentence `buildRegistry` already writes at its call site.
   */
  async describe(endpoint: ModelEndpoint, modelId: string): Promise<ModelCapabilityHint> {
    const provider = this.pick(endpoint);
    return (
      (await provider.describe?.(endpoint, modelId)) ?? { endpointId: endpoint.endpointId, modelId }
    );
  }

  invoke(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<ProviderResult> {
    return this.pick(req.endpoint).invoke(req, opts);
  }

  /**
   * Delegated, and it **throws** for an adapter that cannot count.
   *
   * The alternative — leaving the method off the router — would hide a native
   * counter behind it, and §3.6's rule is provider-native counting *only*, so an
   * adapter that has one is the whole reason not to reach for a foreign
   * tokenizer. Faking it here would break the same rule from the other side.
   *
   * The signal a caller should read is `RuntimeCapabilities.tokenCounter`, which
   * answers "can this endpoint count" honestly per endpoint. Method presence
   * cannot: the router serves many adapters and they differ.
   */
  countTokens(req: ProviderRequest): Promise<number> {
    const provider = this.pick(req.endpoint);
    if (provider.countTokens === undefined) {
      return Promise.reject(
        new Error(
          `${provider.id} counts no tokens of its own; read RuntimeCapabilities.tokenCounter ` +
            'before asking, and never substitute a foreign tokenizer (§3.6)',
        ),
      );
    }
    return provider.countTokens(req);
  }
}
