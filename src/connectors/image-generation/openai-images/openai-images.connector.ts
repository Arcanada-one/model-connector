import OpenAI from 'openai';

interface OpenAIWithKey extends OpenAI {
  apiKey: string;
}
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { BaseImageConnector } from '../base-image.connector';
import type { ImageGenerationRequest, ImageGenerationResult, ProviderId } from '../types';
import { calculateCostUsd, calculateOpenAIImageCostUsd } from '../pricing';
import { isPlaceholder } from '../errors/is-placeholder';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';

const VAULT_PATH = 'arcanada/prod/env/model-connector-openai-images';

// Quality map: our internal quality → OpenAI quality param
const QUALITY_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

// Model map: our tier/quality → model+quality combo
const MODEL_ID_MAP: Record<string, string> = {
  low: 'openai:gpt-image-2.5-sunburst-low',
  medium: 'openai:gpt-image-2.5-sunburst-medium',
  high: 'openai:gpt-image-2.5-sunburst-high',
};

/**
 * OpenAI GPT Image 2.5 Sunburst connector.
 * Uses the `openai` npm package's images.generate method.
 */
export class OpenAIImagesConnector extends BaseImageConnector {
  private readonly client: OpenAIWithKey;
  private readonly apiKey: string;

  constructor(apiKey: string, cbManager: CircuitBreakerManager) {
    super(cbManager);
    this.apiKey = apiKey;
    this.client = new OpenAI({ apiKey }) as OpenAIWithKey;
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (isPlaceholder(this.apiKey)) {
      throw new ProviderNotProvisionedError('openai-images', VAULT_PATH);
    }

    const quality = req.quality ?? 'high';
    const modelId = MODEL_ID_MAP[quality] ?? 'openai:gpt-image-2.5-sunburst-high';
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
        size = '1536x864';
      } else if (req.aspectRatio === '9:16') {
        size = '864x1536';
      }

      if ((req.width && req.width % 16 !== 0) || (req.height && req.height % 16 !== 0)) {
        throw new Error('GPT Image 2.5 Sunburst requires width and height to be divisible by 16');
      }
      if (req.width && req.height) {
        const ratio = req.width / req.height;
        if (ratio < 1 / 3 || ratio > 3) {
          throw new Error('GPT Image 2.5 Sunburst supports aspect ratios from 1:3 through 3:1');
        }
      }

      const body = {
        model: 'gpt-image-2.5-sunburst',
        prompt: req.prompt,
        n: count,
        quality: QUALITY_MAP[quality] ?? 'high',
        size,
        output_format: 'png',
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
        usage?: {
          input_tokens_details?: { image_tokens?: number; text_tokens?: number };
          output_tokens_details?: { image_tokens?: number; text_tokens?: number };
        };
      };

      if (!data.data?.length) {
        throw new Error('OpenAI Images API returned empty data');
      }

      const latencyMs = Date.now() - startMs;
      const costUsd = data.usage
        ? (calculateOpenAIImageCostUsd(data.usage) ?? calculateCostUsd(modelId, count))
        : calculateCostUsd(modelId, count);
      // GPT Image models return base64, not a temporary URL. Normalize it to a data URI.
      const urls = data.data
        .map((item) => {
          if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
          return '';
        })
        .filter(Boolean);
      if (urls.length === 0) {
        throw new Error('OpenAI GPT Image API response contained no base64 image data');
      }

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
          reason: `openai gpt-image-2.5-sunburst quality=${quality}`,
          candidate: { modelId, providerId: 'openai-images' as ProviderId, tier: req.tier },
          costUsd,
        },
      };
    });
  }
}
