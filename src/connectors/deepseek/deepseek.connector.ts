import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

interface DeepSeekChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

const DEFAULT_MODEL = 'deepseek-chat';
const STATIC_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

/**
 * A2-201 — hand-curated list price per model, USD per 1M tokens, from
 * https://api-docs.deepseek.com/quick_start/pricing (fetched 2026-09-23; cross-checked
 * against three independent third-party trackers the same day, e.g.
 * https://benchlm.ai/deepseek/api-pricing "DeepSeek API Pricing (September 2026):
 * $0.30-$1.20 per 1M Tokens"). DeepSeek prices vary by time of day — off-peak
 * (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri) is HALF the peak rate. This catalogue has
 * one number per model, not a schedule, so PEAK is used deliberately: the same
 * conservative direction `measured-cost.ts` already takes for an unknown cache rate
 * ("can overstate the cost of a cache hit, and never understate it") — the caller-facing
 * risk this exists to close is a spend cap that never trips, not one that trips a few
 * cents early. `cachedInputPerMTok` (the cache-HIT price, ~1/50 of cache-miss) has no
 * catalogue column yet (see `MeasuredCostPricing.cachedInputPerMTok` in
 * `src/billing/measured-cost.ts`) — same gap Anthropic's list price already documents —
 * so it is left out here rather than invented; cached tokens bill at the miss rate below,
 * which is again the overstating direction. Recorded as `cache_rates: not_measured` in
 * the admission receipt.
 *
 * Keyed by the id DeepSeek's own API echoes back on `response.model` — `deepseek-flash`
 * and `deepseek-v4-pro` — which is what `meterCost()` (connectors.service.ts) looks up,
 * regardless of which alias the caller requested. `deepseek-chat` / `deepseek-reasoner`
 * (this connector's own `STATIC_MODELS`/`DEFAULT_MODEL`, above) are NOT priced here: the
 * same research found the DeepSeek docs no longer mention either string and a changelog
 * entry dated 2026-04-24 saying both "will be discontinued ... (2026-07-24)". That is a
 * conflicting signal against this connector's own `STATIC_MODELS` still listing them
 * (last touched by #136, merged 2026-09-23) and was not re-checked against a live,
 * authenticated DeepSeek call in this change — flagged in the A2-201 report as a
 * follow-up, not resolved by a silent default here.
 */
export const DEEPSEEK_LIST_PRICES_USD_PER_MTOK: Readonly<
  Record<string, { inputPerMTok: number; outputPerMTok: number }>
> = {
  'deepseek-flash': { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  'deepseek-v4-pro': { inputPerMTok: 1.32, outputPerMTok: 3.96 },
};
const PRICE_UNIT = 'USD/1M tokens';

/** Attach the curated list price to a model meta; unknown ids keep `pricing: null`. */
function withListPrice(meta: ProviderModelMeta): ProviderModelMeta {
  const price = DEEPSEEK_LIST_PRICES_USD_PER_MTOK[meta.id];
  if (!price) return { ...meta, pricing: meta.pricing ?? null };
  return { ...meta, pricing: { ...price, unit: PRICE_UNIT } };
}

/**
 * Native adapter for the official DeepSeek OpenAI-compatible API.
 *
 * The provider supports more features than this bounded adapter advertises:
 * streaming, tools, and JSON schema remain false until implemented and tested.
 * @see https://api-docs.deepseek.com/
 */
export class DeepSeekConnector extends BaseApiConnector {
  readonly name = 'deepseek';

  protected getBaseUrl(): string {
    return process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  }

  private endpoint(path: string): string {
    const base = this.getBaseUrl();
    return `${base}${base.endsWith('/') ? '' : '/'}${path}`;
  }

  protected getStaticModels(): string[] {
    return STATIC_MODELS;
  }

  /** A2-201 — the offline/CI floor carries the curated list price, same as anthropic. */
  protected getStaticModelMetas(): ProviderModelMeta[] {
    return STATIC_MODELS.map((id) => withListPrice({ id }));
  }

  /**
   * A2-201 — DeepSeek's live `/models` listing carries no prices (ids only, see
   * `__fixtures__/models.json`), so without this override a successful refresh would
   * REPLACE the curated floor with an unpriced list and `measureCostUsd` would fall to
   * `'unpriced'` for every DeepSeek request — the exact bug this change closes. Merge:
   * live ids keep the curated price when one exists; unknown live ids stay unpriced
   * (null), never invented.
   */
  protected extractModels(json: unknown): ProviderModelMeta[] {
    return super.extractModels(json).map(withListPrice);
  }

  protected getModelsUrl(): string {
    return this.endpoint('models');
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ''}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return this.endpoint('chat/completions');
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') {
      throw new Error('deepseek connector requires string prompt');
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      messages,
      stream: false,
    };
    const extra = request.extra ?? {};
    if (extra.max_tokens != null) body.max_tokens = extra.max_tokens;
    if ((request.model || DEFAULT_MODEL) !== 'deepseek-reasoner') {
      for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) {
        if (extra[key] != null) body[key] = extra[key];
      }
    }
    return body;
  }

  protected parseResponse(json: DeepSeekChatResponse, request: ConnectorRequest): ParsedApiOutput {
    const message = json.choices?.[0]?.message;
    if (!message) {
      return {
        text: '',
        model: json.model || request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No choices in DeepSeek response',
      };
    }
    const usage = json.usage;
    // AUP-CACHE-003 / A2-104 — DeepSeek reports prompt-cache use as
    // `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, which together are the
    // request's prompt tokens (https://api-docs.deepseek.com/guides/kv_cache). The hit
    // count is this codebase's `cachedInputTokens`: input tokens the provider served
    // from its cache, a SUBSET of inputTokens. Leaving it undefined while the counts sat
    // in `structured` made every consumer of the normalised usage read "the provider is
    // silent about caching" for a provider that had just reported a hit.
    //
    // There is deliberately NO `cacheCreationInputTokens` here: DeepSeek has no separate
    // cache-WRITE counter — a miss token is billed at the miss rate and is itself the
    // write — and a 0 would be indistinguishable from a measured zero on a provider that
    // does report writes.
    const cachedInputTokens =
      typeof usage?.prompt_cache_hit_tokens === 'number'
        ? usage.prompt_cache_hit_tokens
        : undefined;
    const cacheCounts =
      usage != null &&
      (typeof usage.prompt_cache_hit_tokens === 'number' ||
        typeof usage.prompt_cache_miss_tokens === 'number')
        ? {
            usage: {
              prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
              prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
            },
          }
        : {};
    return {
      text: message.content || '',
      structured: {
        ...(message.reasoning_content != null
          ? { reasoning_content: message.reasoning_content }
          : {}),
        // The counts are echoed only when DeepSeek actually sent them. The previous
        // `?? 0` filled a field the provider had left empty, which is the one thing
        // AUP-CACHE-003 says a connector must never do.
        ...cacheCounts,
      },
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      costUsd: 0,
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      // The provider's usage object verbatim: the typed fields above are a derived view,
      // this is the record.
      ...(usage != null ? { providerUsage: { ...usage } } : {}),
      // The third verdict: DeepSeek returned no usage at all, so the zeros above are
      // absences and must be readable as such rather than as measured zeros.
      ...(usage == null ? { usageMissing: true as const } : {}),
      isError: false,
    };
  }

  protected classifyHttpError(status: number, body: string): string {
    return status === 402 ? 'billing_error' : super.classifyHttpError(status, body);
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    return {
      name: 'deepseek',
      type: 'api',
      models: modelMeta.map((model) => model.id),
      modelMeta,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }
}
