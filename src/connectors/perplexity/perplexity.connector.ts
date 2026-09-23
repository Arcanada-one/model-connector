import { BaseApiConnector, ParsedApiOutput, ParsedHttpError } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

export const PERPLEXITY_SONAR_ENDPOINT = 'https://api.perplexity.ai/v1/sonar';
export const PERPLEXITY_SONAR_MODELS = [
  'sonar',
  'sonar-pro',
  'sonar-reasoning-pro',
  'sonar-deep-research',
] as const;

interface PerplexityResponse {
  model: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  [key: string]: unknown;
}

/**
 * A2-223 — hand-curated list price per model, USD per 1M tokens, from
 * Perplexity's published pricing page
 * https://docs.perplexity.ai/getting-started/pricing (fetched 2026-09-23).
 *
 * Token prices only, and that is an UNDERSTATEMENT this file owns rather than
 * hides: Sonar bills per-request search fees on top of tokens (by search
 * context size), and `sonar-deep-research` additionally bills citation tokens
 * ($2/1M), reasoning tokens ($3/1M) and search queries ($5/1K). None of those
 * are token counts this connector receives, and none has a catalogue column, so
 * a request's real cost is HIGHER than the figure computed from this table —
 * the opposite of the conservative direction every other price map here takes.
 * It is still a large improvement on `costSource: 'unpriced'`, which charged
 * $0.000000, and it is recorded as `search_and_citation_fees: not_measured`
 * rather than rounded away.
 */
export const PERPLEXITY_LIST_PRICES_USD_PER_MTOK: Readonly<
  Record<string, { inputPerMTok: number; outputPerMTok: number }>
> = {
  sonar: { inputPerMTok: 1.0, outputPerMTok: 1.0 },
  'sonar-pro': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'sonar-reasoning-pro': { inputPerMTok: 2.0, outputPerMTok: 8.0 },
  'sonar-deep-research': { inputPerMTok: 2.0, outputPerMTok: 8.0 },
};
const PERPLEXITY_PRICE_UNIT = 'USD/1M tokens';

const DOCUMENTED_OPTIONS = new Set([
  'max_tokens',
  'stream',
  'stop',
  'temperature',
  'top_p',
  'response_format',
  'web_search_options',
  'search_mode',
  'return_images',
  'return_related_questions',
  'enable_search_classifier',
  'disable_search',
  'search_domain_filter',
  'search_language_filter',
  'search_recency_filter',
  'search_after_date_filter',
  'search_before_date_filter',
  'last_updated_before_filter',
  'last_updated_after_filter',
  'image_format_filter',
  'image_domain_filter',
  'stream_mode',
  'reasoning_effort',
  'language_preference',
]);

export class PerplexityConnector extends BaseApiConnector {
  readonly name = 'perplexity';

  protected getBaseUrl(): string {
    return 'https://api.perplexity.ai';
  }

  protected getStaticModels(): string[] {
    return [...PERPLEXITY_SONAR_MODELS];
  }

  /** A2-223 — the offline/CI floor carries the curated list price. */
  protected getStaticModelMetas(): ProviderModelMeta[] {
    return PERPLEXITY_SONAR_MODELS.map((id) => {
      const price = PERPLEXITY_LIST_PRICES_USD_PER_MTOK[id];
      return {
        id,
        modality: 'chat' as const,
        free: false,
        pricing: price ? { ...price, unit: PERPLEXITY_PRICE_UNIT } : null,
      };
    });
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY || ''}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return PERPLEXITY_SONAR_ENDPOINT;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') {
      throw new Error('perplexity connector requires string prompt');
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model || 'sonar',
      messages,
    };
    for (const [key, value] of Object.entries(request.extra ?? {})) {
      if (DOCUMENTED_OPTIONS.has(key) && value !== undefined) body[key] = value;
    }
    return body;
  }

  protected parseResponse(json: PerplexityResponse, request: ConnectorRequest): ParsedApiOutput {
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      structured: json,
      model: json.model || request.model || 'sonar',
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      costUsd: 0,
      isError: !choice,
      errorMessage: choice ? undefined : 'No choices in Perplexity response',
    };
  }

  protected parseHttpError(status: number, text: string, headers: Headers): ParsedHttpError {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (status === 401) return { type: 'auth_error', message: text.slice(0, 500) };
    if (status === 403) return { type: 'permission_error', message: text.slice(0, 500) };
    if (status === 422) {
      const details = (body as { detail?: unknown })?.detail;
      return { type: 'validation_error', message: text.slice(0, 500), details };
    }
    if (status === 429) {
      // A2-207 — `Retry-After` is SECONDS on the wire (RFC 9110) and
      // milliseconds in our envelope, hence the conversion. The `> 0` guard is
      // not cosmetic: a MISSING header makes `headers.get()` return null,
      // `Number(null)` is 0, and 0 is finite — so every header-less 429 used to
      // advertise `retryAfter: 0`, i.e. "retry immediately", which is the one
      // answer a rate limit never means.
      const seconds = Number(headers?.get?.('retry-after'));
      return {
        type: 'rate_limited',
        message: text.slice(0, 500),
        retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined,
      };
    }
    if (status >= 500) return { type: 'server_error', message: text.slice(0, 500) };
    return super.parseHttpError(status, text, headers);
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map(({ id }) => id),
      modelMeta,
      freeModels: [],
      supportsStreaming: true,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }
}
