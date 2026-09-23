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

/**
 * A2-223 — hand-curated list price per text model, USD per 1M tokens, from
 * xAI's published model table https://docs.x.ai/docs/models (fetched
 * 2026-09-23).
 *
 * xAI prices each model TWICE: a standard rate below a 200k-token context and a
 * higher extended rate at or above it (grok-4.3: $1.25/$2.50 standard,
 * $2.50/$5.00 extended). The catalogue row holds one number per model, not a
 * function of request size, so the STANDARD rate is used — and that is the one
 * direction of error this file must own: a request over 200k tokens is billed
 * at half its real rate. It is taken because the alternative, pricing every
 * short request at the extended rate, overstates the common case by 2x, and
 * because the extended tier is reachable only by a caller who already knows
 * they are sending 200k tokens. Recorded as `context_tier: not_measured` rather
 * than hidden: closing it needs a second tariff column
 * (`MeasuredCostPricing`), which is the same gap
 * `cachedInputPerMTok` already documents.
 *
 * The four `grok-imagine-*` entries are deliberately absent: they are image and
 * video models billed per image/second, not per token, and a per-MTok row for
 * them would be a category error rather than a missing number. They are carried
 * in `PRICE_COVERAGE_WAIVERS` (src/billing/price-coverage.ts) so the gap is
 * listed rather than silent.
 */
export const GROK_LIST_PRICES_USD_PER_MTOK: Readonly<
  Record<string, { inputPerMTok: number; outputPerMTok: number }>
> = {
  'grok-4.3': { inputPerMTok: 1.25, outputPerMTok: 2.5 },
  'grok-4.20-0309-reasoning': { inputPerMTok: 1.25, outputPerMTok: 2.5 },
  'grok-4.20-0309-non-reasoning': { inputPerMTok: 1.25, outputPerMTok: 2.5 },
  'grok-4.20-multi-agent-0309': { inputPerMTok: 1.25, outputPerMTok: 2.5 },
  'grok-build-0.1': { inputPerMTok: 1.0, outputPerMTok: 2.0 },
};
const PRICE_UNIT = 'USD/1M tokens';

/** Attach the curated list price to a model meta; unknown ids keep `pricing: null`. */
function withListPrice(meta: ProviderModelMeta): ProviderModelMeta {
  const price = GROK_LIST_PRICES_USD_PER_MTOK[meta.id];
  if (!price) return { ...meta, pricing: meta.pricing ?? null };
  return { ...meta, pricing: { ...price, unit: PRICE_UNIT } };
}

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

  /** A2-223 — the offline/CI floor carries the curated list price. */
  protected getStaticModelMetas(): ProviderModelMeta[] {
    return GROK_STATIC_MODEL_METAS.map(withListPrice);
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
      // A2-223 — the live listing exposes no machine price (see the docstring
      // above), so a refresh used to REPLACE the floor with an unpriced list
      // and the meter fell to `costSource: 'unpriced'` for every grok request.
      // Merge: live ids keep the curated price when one exists; unknown live
      // ids stay unpriced (null), never invented.
      out.push(withListPrice({ id, modality: this.classifyGrokModality(id), free: false }));
    }
    return out;
  }

  private classifyGrokModality(id: string): ModelModality {
    if (id.startsWith('grok-imagine-image')) return 'image_generation';
    if (id.startsWith('grok-imagine-video')) return 'video';
    return 'chat';
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
