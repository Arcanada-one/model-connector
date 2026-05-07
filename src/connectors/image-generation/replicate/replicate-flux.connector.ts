import Replicate from 'replicate';

interface ReplicateWithAuth extends Replicate {
  auth: string;
}
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { BaseImageConnector } from '../base-image.connector';
import type { ImageGenerationRequest, ImageGenerationResult, ProviderId } from '../types';
import { calculateCostUsd } from '../pricing';

const MODEL_ID = 'replicate:flux-pro';
const REPLICATE_MODEL = 'black-forest-labs/flux-pro';

/**
 * Replicate FLUX.1 Pro connector.
 * Uses `replicate` npm package for predictions.create.
 */
export class ReplicateFluxConnector extends BaseImageConnector {
  private readonly client: ReplicateWithAuth;

  constructor(apiToken: string, cbManager: CircuitBreakerManager) {
    super(cbManager);
    this.client = new Replicate({ auth: apiToken }) as ReplicateWithAuth;
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
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
        },
      };
    });
  }
}
