import Replicate from 'replicate';

interface ReplicateWithAuth extends Replicate {
  auth: string;
}
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { BaseImageConnector } from '../base-image.connector';
import type { ImageGenerationRequest, ImageGenerationResult, ProviderId } from '../types';
import { calculateCostUsd } from '../pricing';
import { isPlaceholder } from '../errors/is-placeholder';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';

const VAULT_PATH = 'arcanada/prod/env/model-connector-replicate';

const MODEL_ID = 'replicate:flux-pro';
const REPLICATE_MODEL = 'black-forest-labs/flux-pro';

// TODO(CONN-0052 Phase 3 — SSRF check):
// Replicate returns generated image URLs from replicate.delivery CDN.
// These URLs must NOT be fetched server-side without origin validation.
// Phase 3 task: add allowlist check (URL must match *.replicate.delivery domain)
// before any server-side fetch of Replicate output URLs.
// Until then: Replicate URLs are returned as-is to the client (client fetches directly).
// See: INSIGHTS-CONN-0052.md § Risk R2 — Replicate URL TTL

/**
 * Replicate FLUX.1 Pro connector.
 * Uses `replicate` npm package for predictions.create.
 */
export class ReplicateFluxConnector extends BaseImageConnector {
  private readonly client: ReplicateWithAuth;
  private readonly apiToken: string;

  constructor(apiToken: string, cbManager: CircuitBreakerManager) {
    super(cbManager);
    this.apiToken = apiToken;
    this.client = new Replicate({ auth: apiToken }) as ReplicateWithAuth;
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (isPlaceholder(this.apiToken)) {
      throw new ProviderNotProvisionedError('replicate', VAULT_PATH);
    }

    const startMs = Date.now();
    const count = req.count ?? 1;

    return this.withCircuit(MODEL_ID, async () => {
      const REPLICATE_API = 'https://api.replicate.com';
      const url = `${REPLICATE_API}/v1/models/${REPLICATE_MODEL}/predictions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.client.auth}`,
          'Content-Type': 'application/json',
          Prefer: 'wait', // Replicate sync wait
        },
        body: JSON.stringify({
          input: {
            prompt: req.prompt,
            ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
            num_outputs: count,
            aspect_ratio: req.aspectRatio ?? '1:1',
            output_format: 'png',
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Replicate API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        id: string;
        status: string;
        output?: string[];
        metrics?: { predict_time?: number };
      };

      if (data.status === 'failed') {
        throw new Error(`Replicate prediction failed for ${MODEL_ID}`);
      }

      const latencyMs = Date.now() - startMs;
      const costUsd = calculateCostUsd(MODEL_ID, count);
      const urls = Array.isArray(data.output) ? data.output : [];

      return {
        requestId: crypto.randomUUID(),
        status: 'completed',
        urls,
        costUsd,
        latencyMs,
        routing: {
          chosenProvider: 'replicate' as ProviderId,
          chosenModel: MODEL_ID,
          fallbackUsed: false,
          reason: 'replicate flux-pro',
          candidate: { modelId: MODEL_ID, providerId: 'replicate' as ProviderId, tier: req.tier },
          costUsd,
        },
      };
    });
  }
}
