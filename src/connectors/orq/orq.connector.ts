// CONN-0239 — orq.ai OpenAI-compatible gateway connector.
// Base: https://api.orq.ai/v2
// Chat:  POST /v2/proxy/chat/completions
// Models: GET /v2/models  → top-level JSON array (not {data:[]})
import { Logger } from '@nestjs/common';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  CatalogRefreshResult,
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

interface OrqChatResponse {
  id: string;
  object: string;
  created: number;
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
  };
}

// /v2/models array entry — partial; the fields we filter on plus the pricing
// and context the provider publishes for every entry (CONN-0271).
interface OrqModelEntry {
  model_id: string;
  model_type: string; // 'chat' | 'image' | 'embedding' | 'rerank' | 'tts' | 'stt' | ...
  is_active: boolean;
  // USD per 1K tokens (NOT per token — see ORQ_PRICE_PER_1K_TO_PER_MTOK).
  input_cost?: number | null;
  output_cost?: number | null;
  metadata?: {
    context_window?: number | null;
    max_output_tokens?: number | null;
  } | null;
}

// orq quotes prices per 1K tokens. Verified against two models whose list price
// is public: gpt-4o reports 0.0025 (list $2.50/1M) and gpt-4o-mini reports
// 0.00015 (list $0.15/1M). Multiplying by 1e3 yields per-1M-token USD, which is
// the unit `model_catalog.inputPerMTok` stores. Do NOT route these through
// normalizePerMTokPrice(): that helper assumes a per-TOKEN quote and scales by
// 1e6, which would overstate every orq model by exactly 1000x.
const ORQ_PRICE_PER_1K_TO_PER_MTOK = 1_000;

function orqPricePerMTok(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Number((raw * ORQ_PRICE_PER_1K_TO_PER_MTOK).toFixed(6));
}

const DEFAULT_MODEL = 'gpt-4o-mini';

// Fallback seed so the catalog is never empty if /v2/models is unreachable at boot.
// Small set of verified-live chat model_ids from the saved fixture.
const STATIC_SEED_MODELS: string[] = ['gpt-4o-mini', 'gpt-4o', 'deepseek-ai/DeepSeek-R1'];

export class OrqConnector extends BaseApiConnector {
  readonly name = 'orq';
  private readonly logger = new Logger(OrqConnector.name);
  // Starts as seed; replaced by refreshModels() on module init.
  private _dynamicModels: string[] = [...STATIC_SEED_MODELS];
  // CONN-0271 — per-model metadata (pricing/context) from the same refresh, so
  // `models` and `modelMeta` cannot drift apart.
  private _dynamicMetas: ProviderModelMeta[] = [];

  protected getBaseUrl(): string {
    return 'https://api.orq.ai/v2';
  }

  protected getTimeout(): number {
    return Number(process.env.ORQ_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = process.env.ORQ_API_KEY || '';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/proxy/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }

    if (typeof request.prompt !== 'string') {
      throw new Error('orq connector requires a string prompt');
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

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as OrqChatResponse;
    const choice = response.choices?.[0];

    if (!choice) {
      return {
        text: '',
        model: response.model || request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No choices in response',
      };
    }

    return {
      text: choice.message.content || '',
      model: response.model || request.model || DEFAULT_MODEL,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      // orq is a paid gateway that does not echo per-call cost in the response.
      // Never invent a cost figure — always 0.
      costUsd: 0,
      isError: false,
    };
  }

  /**
   * Fetch GET /v2/models (top-level JSON ARRAY, not {data:[...]}),
   * keep only chat + active entries, cache their model_id strings.
   *
   * Tolerates all failure modes: network error, non-200, non-array body,
   * or 0 qualifying entries — leaves _dynamicModels as the static seed so
   * the catalog is never empty. Mirrors openrouter.refreshFreeModels() pattern.
   */
  override async refreshModels(): Promise<CatalogRefreshResult> {
    const checkedAt = new Date();
    let response: Response;
    try {
      const url = `${this.getBaseUrl()}/models`;
      response = await fetch(url, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.warn(`orq /models returned ${response.status} — keeping seed list`);
        return { status: 'failed', source: 'provider-api', checkedAt, reason: 'http' };
      }
    } catch {
      this.logger.warn('orq model refresh failed: reason=network — keeping seed list');
      return { status: 'failed', source: 'provider-api', checkedAt, reason: 'network' };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      this.logger.warn('orq model refresh failed: reason=parse — keeping seed list');
      return { status: 'failed', source: 'provider-api', checkedAt, reason: 'parse' };
    }

    if (!Array.isArray(json)) {
      this.logger.warn('orq /models response is not an array — keeping seed list');
      return { status: 'failed', source: 'provider-api', checkedAt, reason: 'parse' };
    }

    const ids: string[] = [];
    const metas: ProviderModelMeta[] = [];
    // CONN-0270 — dedupe by model_id. orq's /models can list the same model_id
    // more than once; a single duplicate makes the downstream snapshot
    // validation (CatalogSnapshotValidationError) reject the ENTIRE orq
    // snapshot, silently dropping all ~524 models from the catalog. Keep the
    // first occurrence and surface the count.
    const seen = new Set<string>();
    let duplicates = 0;
    for (const entry of json as OrqModelEntry[]) {
      if (typeof entry?.model_id !== 'string') continue;
      if (entry.model_type === 'chat' && entry.is_active === true) {
        if (seen.has(entry.model_id)) {
          duplicates += 1;
          continue;
        }
        seen.add(entry.model_id);
        ids.push(entry.model_id);
        // CONN-0271 — the provider publishes a machine price for every entry.
        // Emitting it is what moves an orq request from costSource='unpriced'
        // (revenue we never computed) to 'catalog'. A model missing either half
        // emits pricing:null rather than a half-price we would silently bill on.
        const inputPerMTok = orqPricePerMTok(entry.input_cost);
        const outputPerMTok = orqPricePerMTok(entry.output_cost);
        metas.push({
          id: entry.model_id,
          modality: 'chat',
          pricing:
            inputPerMTok !== null && outputPerMTok !== null
              ? { inputPerMTok, outputPerMTok, unit: 'per_1m_tokens' }
              : null,
          contextWindow: entry.metadata?.context_window ?? null,
          maxOutputTokens: entry.metadata?.max_output_tokens ?? null,
        });
      }
    }
    if (duplicates > 0) {
      this.logger.warn(`orq /models returned ${duplicates} duplicate model_id(s) — deduped`);
    }

    if (ids.length === 0) {
      this.logger.warn('orq /models yielded 0 chat+active models — keeping seed list');
      return { status: 'failed', source: 'provider-api', checkedAt, reason: 'empty' };
    }

    this._dynamicModels = ids;
    this._dynamicMetas = metas;
    const priced = metas.filter((m) => m.pricing !== null).length;
    const observedAt = new Date();
    this.logger.log(
      `orq model refresh: ${ids.length} chat models discovered (${priced} with provider pricing)`,
    );
    return { status: 'success', source: 'provider-api', observedAt };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'orq',
      type: 'api',
      // Seed at boot (~3 models); replaced by ~421 after refreshModels().
      models: this._dynamicModels,
      // No freeModels — orq is a paid gateway with no per-call free tier.
      modelMeta: this._dynamicMetas.length > 0 ? this._dynamicMetas : undefined,
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}
