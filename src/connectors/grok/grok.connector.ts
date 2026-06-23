import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';
import { ModelModality } from '../dto/catalog.dto';

interface GrokChatResponse {
  id: string;
  object?: string;
  created?: number;
  model: string;
  choices: Array<{
    index?: number;
    message: { role: string; content: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
}

const DEFAULT_MODEL = 'grok-4.3';

// CONN-0238 — offline/CI fallback = the real 9 (operator live capture 2026-06-23),
// replacing the CONN-0236 phantom static list. refreshModels() against /v1/models
// supersedes it at runtime (REPLACE) where XAI_API_KEY is present. Each carries its
// modality so the static floor classifies grok-imagine image/video correctly even
// offline.
const GROK_STATIC_MODEL_METAS: ProviderModelMeta[] = [
  { id: 'grok-4.3', modality: 'chat' },
  { id: 'grok-4.20-0309-reasoning', modality: 'chat' },
  { id: 'grok-4.20-0309-non-reasoning', modality: 'chat' },
  { id: 'grok-4.20-multi-agent-0309', modality: 'chat' },
  { id: 'grok-build-0.1', modality: 'chat' },
  { id: 'grok-imagine-image', modality: 'image_generation' },
  { id: 'grok-imagine-image-quality', modality: 'image_generation' },
  { id: 'grok-imagine-video', modality: 'video' },
  { id: 'grok-imagine-video-1.5', modality: 'video' },
];

export class GrokConnector extends BaseApiConnector {
  readonly name = 'grok';

  protected getBaseUrl(): string {
    return 'https://api.x.ai';
  }

  // CONN-0236 — xAI exposes an OpenAI-compat model listing at /v1/models.
  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/v1/models`;
  }

  protected getStaticModels(): string[] {
    return GROK_STATIC_MODEL_METAS.map((m) => m.id);
  }

  protected getStaticModelMetas(): ProviderModelMeta[] {
    return GROK_STATIC_MODEL_METAS;
  }

  /**
   * CONN-0238 — xAI /v1/models returns ids only (no pricing/context fields), so
   * modality is classified by id: `grok-imagine-image*` → image_generation,
   * `grok-imagine-video*` → video, everything else (reasoning/build text models) →
   * chat. Pricing/context stay null (the listing exposes no machine price).
   */
  protected extractModels(json: unknown): ProviderModelMeta[] {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    const out: ProviderModelMeta[] = [];
    for (const entry of data) {
      const id = (entry as { id?: unknown })?.id;
      if (typeof id !== 'string' || id.length === 0) continue;
      out.push({ id, modality: this.classifyGrokModality(id), free: false });
    }
    return out;
  }

  private classifyGrokModality(id: string): ModelModality {
    if (id.startsWith('grok-imagine-image')) return 'image_generation';
    if (id.startsWith('grok-imagine-video')) return 'video';
    return 'chat';
  }

  protected getTimeout(): number {
    return Number(process.env.GROK_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = process.env.XAI_API_KEY || '';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/v1/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    // ARCA-0011: ContentBlock[] is rejected by the base-class guard
    // (`supportsContentBlocks=false`) before reaching this branch.
    if (typeof request.prompt !== 'string') {
      throw new Error('grok connector requires string prompt');
    }
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      messages,
    };

    if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    if (request.extra?.max_tokens != null) {
      body.max_tokens = request.extra.max_tokens;
    }
    if (request.extra?.temperature != null) {
      body.temperature = request.extra.temperature;
    }
    if (request.extra?.top_p != null) {
      body.top_p = request.extra.top_p;
    }

    return body;
  }

  protected parseResponse(json: GrokChatResponse, request: ConnectorRequest): ParsedApiOutput {
    const choice = json.choices?.[0];
    if (!choice) {
      return {
        text: '',
        model: json.model || request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No choices in response',
      };
    }

    return {
      text: choice.message.content || '',
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    // CONN-0238 — static real-9 (with modality) until refreshModels() REPLACES it
    // with the live list. modelMeta carries per-model modality (chat/image/video).
    const modelMeta = this.dynamicModelMetas;
    return {
      name: 'grok',
      type: 'api',
      models: modelMeta.map((m) => m.id),
      modelMeta,
      // CONN-0233 — reviewed 2026-06-22: xAI/Grok has no free tier.
      // All models are pay-per-token. Source: https://docs.x.ai/docs/pricing
      freeModels: [],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}
