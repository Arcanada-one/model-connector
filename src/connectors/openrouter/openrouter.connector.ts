import { Logger } from '@nestjs/common';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ContentBlock,
  ProviderModelMeta,
} from '../interfaces/connector.interface';
import { normalizePerMTokPrice } from '../dto/catalog.dto';

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    total_cost?: number;
  };
}

// CONN-0233/0238 — OpenRouter /api/v1/models response shape (partial; fields we use).
interface OpenRouterModelEntry {
  id: string;
  pricing?: { prompt?: string; completion?: string } | null;
  context_length?: number | null;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null } | null;
}

interface OpenRouterModelsApiResponse {
  data: OpenRouterModelEntry[];
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';

// Static paid models list (unchanged from pre-CONN-0233).
const STATIC_MODELS = [
  'anthropic/claude-sonnet-4',
  'anthropic/claude-haiku-4',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-2.5-flash',
  'meta-llama/llama-4-maverick',
];

export class OpenRouterConnector extends BaseApiConnector {
  readonly name = 'openrouter';

  private readonly logger = new Logger(OpenRouterConnector.name);

  // CONN-0233/0238 — cached model state populated by refreshFreeModels().
  // CONN-0238: the cache now holds ALL models (REPLACE), not just static+free.
  // A model is free when: pricing.prompt==="0" && pricing.completion==="0",
  // OR its id ends with ":free" (OpenRouter's self-documenting convention).
  // Offline floor = STATIC_MODELS (chat, paid, no machine pricing) until the live
  // fetch REPLACES it with all ~340 entries + per-model free/pricing/context.
  private _dynamicModelMeta: ProviderModelMeta[] = STATIC_MODELS.map((id) => ({
    id,
    modality: 'chat',
    free: false,
  }));
  private get _dynamicFreeModels(): string[] {
    return this._dynamicModelMeta.filter((m) => m.free).map((m) => m.id);
  }
  private get _dynamicModels(): string[] {
    return this._dynamicModelMeta.map((m) => m.id);
  }

  // ARCA-0011 — OpenRouter passes `messages[N].content` through as
  // `string | ContentBlock[]`; OpenAI-compat vision endpoints accept the
  // same shape natively.
  protected get supportsContentBlocks(): boolean {
    return true;
  }

  /**
   * CONN-0233 — Fetch OpenRouter /api/v1/models, compute the free set,
   * and update cached state. Called from OnModuleInit; tolerates failure
   * (leaves freeModels empty, logs a warning — never throws).
   */
  async refreshFreeModels(): Promise<void> {
    try {
      const url = `${this.getBaseUrl()}/v1/models`;
      const response = await fetch(url, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.logger.warn(
          `OpenRouter /v1/models returned ${response.status} — skipping free refresh`,
        );
        return;
      }
      const json = (await response.json()) as OpenRouterModelsApiResponse;
      if (!Array.isArray(json?.data)) {
        this.logger.warn('OpenRouter /v1/models response has no data[] — skipping free refresh');
        return;
      }

      // CONN-0238 — REPLACE the cache with EVERY model the API returns (all ~340),
      // not just the free subset. free=true flags the ~26 free; pricing/context come
      // from each live entry. The catalog surfaces all of them; the page defaults to
      // free-first via a filter, but completeness lives in the catalog.
      const metas: ProviderModelMeta[] = [];
      for (const entry of json.data) {
        if (typeof entry?.id !== 'string') continue;
        const isFreeById = entry.id.endsWith(':free');
        const isFreeByPricing =
          entry.pricing != null && entry.pricing.prompt === '0' && entry.pricing.completion === '0';
        const inputPerMTok = normalizePerMTokPrice(entry.pricing?.prompt);
        const outputPerMTok = normalizePerMTokPrice(entry.pricing?.completion);
        const pricing =
          inputPerMTok !== null || outputPerMTok !== null
            ? { inputPerMTok, outputPerMTok, unit: 'per_1m_tokens' }
            : null;
        const contextWindow = entry.top_provider?.context_length ?? entry.context_length ?? null;
        metas.push({
          id: entry.id,
          modality: 'chat',
          free: isFreeById || isFreeByPricing,
          pricing,
          contextWindow: typeof contextWindow === 'number' ? contextWindow : null,
          maxOutputTokens:
            typeof entry.top_provider?.max_completion_tokens === 'number'
              ? entry.top_provider.max_completion_tokens
              : null,
        });
      }

      if (metas.length === 0) {
        this.logger.warn('OpenRouter /v1/models returned no usable ids — keeping static floor');
        return;
      }
      this._dynamicModelMeta = metas;

      this.logger.log(
        `OpenRouter refresh: ${metas.length} models (${this._dynamicFreeModels.length} free) — REPLACED static floor`,
      );
    } catch (err) {
      this.logger.warn(
        `OpenRouter refresh failed: ${(err as Error).message} — keeping the static paid floor`,
      );
    }
  }

  protected getBaseUrl(): string {
    return 'https://openrouter.ai/api';
  }

  protected getTimeout(): number {
    return Number(process.env.OPENROUTER_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/v1/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const messages: Array<{ role: string; content: string | ContentBlock[] }> = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
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

  protected parseResponse(json: OpenRouterResponse, request: ConnectorRequest): ParsedApiOutput {
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
      costUsd: json.usage?.total_cost ?? 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'openrouter',
      type: 'api',
      // CONN-0238: starts as the STATIC_MODELS floor; after refreshFreeModels() it is
      // REPLACED with all ~340 live models. modelMeta carries per-model free/pricing/
      // context (single source — `models` is derived from it).
      models: this._dynamicModels,
      modelMeta: this._dynamicModelMeta,
      freeModels: this._dynamicFreeModels,
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}
