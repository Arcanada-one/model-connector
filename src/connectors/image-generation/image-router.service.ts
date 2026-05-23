import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';
import { CircuitOpenError } from '../../core/resilience/circuit-breaker';
import type { Tier, ProviderId, RoutingDecision } from './types';
import { IMAGE_CAPABILITIES } from './capabilities';
import { calculateCostUsd } from './pricing';

export class ImageRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRoutingError';
  }
}

/**
 * Primary TIER_MAP: tier → ordered list of [providerId, modelId] pairs.
 * First entry is the primary; subsequent entries are fallbacks in order.
 * Source: CONN-0052 plan §5.3 + creative-routing-policy.
 */
const TIER_MAP: Record<Tier, Array<{ provider: ProviderId; model: string }>> = {
  cheap: [
    { provider: 'vertex', model: 'vertex:nano-banana' },
    // codex:image disabled until IMAGE_PROVIDER_CODEX_ENABLED=true
  ],
  mid: [
    { provider: 'vertex', model: 'vertex:imagen-4-fast' },
    { provider: 'vertex', model: 'vertex:imagen-4' },
    // CONN-0213: fal-ai as last fallback (cheap-tier model but fast)
    { provider: 'fal-ai', model: 'fal-ai:flux/dev' },
  ],
  premium: [
    { provider: 'vertex', model: 'vertex:imagen-4-ultra' },
    { provider: 'replicate', model: 'replicate:flux-pro' },
    { provider: 'openai-images', model: 'openai:gpt-image-1-high' },
    // CONN-0213: fal-ai as last fallback (cheaper than openai-images, watermark:never)
    { provider: 'fal-ai', model: 'fal-ai:flux-pro/v1.1' },
  ],
};

/**
 * Models that always go async regardless of latency estimate.
 * Source: creative-async-strategy §1.
 */
export const ASYNC_PROVIDERS = new Set([
  'vertex:imagen-4-ultra',
  'replicate:flux-pro',
  'openai:gpt-image-1-high',
]);

interface RouteOptions {
  /** Pin to a specific model, bypassing tier routing */
  model?: string;
}

/**
 * Resolves provider + model for an image generation request.
 * Uses TIER_MAP as primary, falls back to next entry when circuit is open.
 */
export class ImageRouterService {
  private readonly cbManager: CircuitBreakerManager;

  constructor(cbManager?: CircuitBreakerManager) {
    this.cbManager = cbManager ?? new CircuitBreakerManager('image-router', 5, 30_000);
  }

  /**
   * Like route(), but skips providers in the `excludedProviders` set.
   * Used to implement fallback when a provider throws ProviderNotProvisionedError.
   */
  routeExcluding(tier: Tier, options: RouteOptions, excludedProviders: string[]): RoutingDecision {
    if (options.model) {
      // Model pin bypass — exclusions don't apply
      return this.route(tier, options);
    }

    const candidates = TIER_MAP[tier];
    if (!candidates || candidates.length === 0) {
      throw new ImageRoutingError(`No candidates configured for tier "${tier}"`);
    }

    const excluded = new Set(excludedProviders);
    let firstSkipped = false;

    for (const candidate of candidates) {
      if (excluded.has(candidate.provider)) {
        firstSkipped = true;
        continue;
      }
      const cb = this.cbManager.getCircuitBreaker(candidate.model);
      try {
        cb.check();
        return {
          chosenProvider: candidate.provider,
          chosenModel: candidate.model,
          fallbackUsed: firstSkipped,
          reason: firstSkipped
            ? `fallback to ${candidate.model} (${excludedProviders.join(', ')} unprovisioned or circuit open)`
            : `tier ${tier} primary`,
          candidate: { modelId: candidate.model, providerId: candidate.provider, tier },
          costUsd: calculateCostUsd(candidate.model, 1),
        };
      } catch {
        firstSkipped = true;
        continue;
      }
    }

    throw new ImageRoutingError(
      `All providers for tier "${tier}" unprovisioned or have open circuits: ${candidates.map((c) => c.provider).join(', ')}`,
    );
  }

  route(tier: Tier, options: RouteOptions): RoutingDecision {
    // Model pin: bypass tier routing entirely
    if (options.model) {
      const cap = IMAGE_CAPABILITIES[options.model as keyof typeof IMAGE_CAPABILITIES];
      const provider: ProviderId = cap?.provider ?? 'vertex';
      return {
        chosenProvider: provider,
        chosenModel: options.model,
        fallbackUsed: false,
        reason: `pinned to model ${options.model}`,
        candidate: { modelId: options.model, providerId: provider, tier },
        costUsd: calculateCostUsd(options.model, 1),
      };
    }

    const candidates = TIER_MAP[tier];
    if (!candidates || candidates.length === 0) {
      throw new ImageRoutingError(`No candidates configured for tier "${tier}"`);
    }

    let firstOpen = false;
    for (const candidate of candidates) {
      const cb = this.cbManager.getCircuitBreaker(candidate.model);
      try {
        cb.check();
        // Circuit is closed/half-open — use this candidate
        return {
          chosenProvider: candidate.provider,
          chosenModel: candidate.model,
          fallbackUsed: firstOpen,
          reason: firstOpen
            ? `fallback to ${candidate.model} (primary circuit open)`
            : `tier ${tier} primary`,
          candidate: { modelId: candidate.model, providerId: candidate.provider, tier },
          costUsd: calculateCostUsd(candidate.model, 1),
        };
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          firstOpen = true;
          continue; // Try next candidate
        }
        throw err;
      }
    }

    throw new ImageRoutingError(
      `All providers for tier "${tier}" have open circuits. No candidate available.`,
    );
  }
}
