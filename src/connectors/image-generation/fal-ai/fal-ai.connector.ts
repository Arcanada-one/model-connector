import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { BaseImageConnector } from '../base-image.connector';
import type { ImageGenerationRequest, ImageGenerationResult, ProviderId } from '../types';
import { calculateCostUsd } from '../pricing';
import { isPlaceholder } from '../errors/is-placeholder';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';

/**
 * Fal.ai image-generation connector — CONN-0213 Phase 1 (image only).
 *
 * Live fixtures captured during /dr-plan (2026-05-23) are recorded in
 * `datarim/tasks/CONN-0213-fixtures.md`. Vault path:
 * `arcanada/prod/env/model-connector-fal-ai` · field `api_key` (full
 * `<key-id>:<secret>` literal, used verbatim in `Authorization: Key …`).
 *
 * Video / audio modalities are deliberately rejected here — CONN-0215 /
 * CONN-0216 cover those when ecosystem use-cases appear.
 */

const VAULT_PATH = 'arcanada/prod/env/model-connector-fal-ai';
const FAL_BASE_URL = 'https://fal.run';
const DEFAULT_MODEL_ID = 'fal-ai:flux/dev';
const REQUEST_TIMEOUT_MS = 60_000;

interface FalImage {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
}

interface FalSuccessResponse {
  images: FalImage[];
  timings?: { inference?: number };
  seed?: number;
  has_nsfw_concepts?: boolean[];
  prompt?: string;
}

interface FalErrorResponse {
  detail?: string;
}

type FalImageSize =
  | 'square_hd'
  | 'square'
  | 'portrait_4_3'
  | 'portrait_16_9'
  | 'landscape_4_3'
  | 'landscape_16_9';

export class FalAiConnector extends BaseImageConnector {
  private readonly apiKey: string;

  constructor(apiKey: string, cbManager: CircuitBreakerManager) {
    super(cbManager);
    this.apiKey = apiKey;
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (isPlaceholder(this.apiKey)) {
      throw new ProviderNotProvisionedError('fal-ai', VAULT_PATH);
    }

    const modelId = req.model ?? DEFAULT_MODEL_ID;
    const falModelPath = modelId.replace(/^fal-ai:/, '');
    const startMs = Date.now();
    const count = req.count ?? 1;

    return this.withCircuit(modelId, async () => {
      const body = this.buildBody(req, falModelPath);
      const response = await fetch(`${FAL_BASE_URL}/fal-ai/${falModelPath}`, {
        method: 'POST',
        headers: {
          Authorization: `Key ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Fal.ai auth error ${response.status}: ${errorText}`);
        }
        throw new Error(`Fal.ai API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as FalSuccessResponse;
      if (!data.images || data.images.length === 0) {
        throw new Error('Fal.ai response missing images[]');
      }

      const urls = data.images.map((img) => img.url).filter(Boolean);
      const inferenceSec = data.timings?.inference;
      const latencyMs =
        typeof inferenceSec === 'number' ? Math.round(inferenceSec * 1000) : Date.now() - startMs;
      const costUsd = calculateCostUsd(modelId, count);

      return {
        requestId: crypto.randomUUID(),
        status: 'completed',
        urls,
        costUsd,
        latencyMs,
        routing: {
          chosenProvider: 'fal-ai' as ProviderId,
          chosenModel: modelId,
          fallbackUsed: false,
          reason: `fal-ai ${falModelPath}`,
          candidate: { modelId, providerId: 'fal-ai' as ProviderId, tier: req.tier },
          costUsd,
        },
      };
    });
  }

  /**
   * Build the Fal.ai request body. Fal.ai uses a named `image_size` enum
   * rather than free-form width/height integers.
   *
   * `flux/dev` is the schnell variant — Fal.ai documents that
   * `num_inference_steps: 4` is required to hit the published $0.025/image rate;
   * the connector always pins it for that model.
   */
  private buildBody(req: ImageGenerationRequest, falModelPath: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      image_size: this.mapSize(req),
    };
    if (req.negativePrompt) {
      body.negative_prompt = req.negativePrompt;
    }
    if (typeof req.seed === 'number') {
      body.seed = req.seed;
    }
    if (falModelPath === 'flux/dev') {
      body.num_inference_steps = 4;
    }
    return body;
  }

  /**
   * Map MC's free-form width/height/aspectRatio onto Fal.ai's image_size enum.
   * Out-of-range or unknown combinations fall back to `square_hd` (1024x1024).
   */
  private mapSize(req: ImageGenerationRequest): FalImageSize {
    if (req.aspectRatio) {
      switch (req.aspectRatio) {
        case '1:1':
          return 'square_hd';
        case '16:9':
          return 'landscape_16_9';
        case '9:16':
          return 'portrait_16_9';
        case '4:3':
          return 'landscape_4_3';
        case '3:4':
          return 'portrait_4_3';
      }
    }
    if (req.width && req.height) {
      if (req.width === req.height) {
        return req.width <= 512 ? 'square' : 'square_hd';
      }
      const ratio = req.width / req.height;
      if (ratio >= 1.7) return 'landscape_16_9';
      if (ratio >= 1.2) return 'landscape_4_3';
      if (ratio <= 1 / 1.7) return 'portrait_16_9';
      if (ratio <= 1 / 1.2) return 'portrait_4_3';
    }
    return 'square_hd';
  }
}

// Internal exports for testing only.
export const __INTERNALS__ = { VAULT_PATH, FAL_BASE_URL, DEFAULT_MODEL_ID, REQUEST_TIMEOUT_MS };

// Re-export for type checks
export type { FalErrorResponse, FalSuccessResponse };
