import OpenAI from 'openai';

interface OpenAIWithKey extends OpenAI {
  apiKey: string;
}
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { BaseImageConnector } from '../base-image.connector';
import type { ImageGenerationRequest, ImageGenerationResult, ProviderId } from '../types';
import { calculateCostUsd } from '../pricing';

// Quality map: our internal quality → OpenAI quality param
const QUALITY_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

// Model map: our tier/quality → model+quality combo
const MODEL_ID_MAP: Record<string, string> = {
  low: 'openai:gpt-image-1-low',
  medium: 'openai:gpt-image-1-medium',
  high: 'openai:gpt-image-1-high',
};

/**
 * OpenAI gpt-image-1 connector.
 * Uses the `openai` npm package's images.generate method.
 */
export class OpenAIImagesConnector extends BaseImageConnector {
  private readonly client: OpenAIWithKey;

  constructor(apiKey: string, cbManager: CircuitBreakerManager) {
    super(cbManager);
    this.client = new OpenAI({ apiKey }) as OpenAIWithKey;
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const quality = req.quality ?? 'high';
    const modelId = MODEL_ID_MAP[quality] ?? 'openai:gpt-image-1-high';
    const startMs = Date.now();
    const count = req.count ?? 1;

    return this.withCircuit(modelId, async () => {
      const OPENAI_API = 'https://api.openai.com';
      const url = `${OPENAI_API}/v1/images/generations`;

      // Determine size from request or default
      let size: string = '1024x1024';
      if (req.width && req.height) {
        size = `${req.width}x${req.height}`;
      } else if (req.aspectRatio === '16:9') {
        size = '1792x1024';
      } else if (req.aspectRatio === '9:16') {
        size = '1024x1792';
      }

      const body = {
        model: 'gpt-image-1',
        prompt: req.prompt,
        n: count,
        quality: QUALITY_MAP[quality] ?? 'high',
        size,
        response_format: 'url',
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.client.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI Images API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        created: number;
        data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
      };

      if (!data.data?.length) {
        throw new Error('OpenAI Images API returned empty data');
      }

      const latencyMs = Date.now() - startMs;
      const costUsd = calculateCostUsd(modelId, count);
      const urls = data.data.map((item) => item.url ?? item.b64_json ?? '').filter(Boolean);

      return {
        requestId: crypto.randomUUID(),
        status: 'completed',
        urls,
        costUsd,
        latencyMs,
        routing: {
          chosenProvider: 'openai-images' as ProviderId,
          chosenModel: modelId,
          fallbackUsed: false,
          reason: `openai gpt-image-1 quality=${quality}`,
        },
      };
    });
  }
}
