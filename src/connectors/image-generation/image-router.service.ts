import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';
import { CircuitOpenError } from '../../core/resilience/circuit-breaker';
import type { Tier, ProviderId, RoutingDecision } from './types';
import { IMAGE_CAPABILITIES } from './capabilities';

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
  ],
  premium: [
    { provider: 'vertex', model: 'vertex:imagen-4-ultra' },
    { provider: 'replicate', model: 'replicate:flux-pro' },
    { provider: 'openai-images', model: 'openai:gpt-image-1-high' },
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
