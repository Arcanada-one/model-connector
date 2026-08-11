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

  protected getStaticModelMetas(): ProviderModelMeta[] {
    return PERPLEXITY_SONAR_MODELS.map((id) => ({ id, modality: 'chat', free: false }));
  }

  protected getTimeout(): number {
    return Number(process.env.PERPLEXITY_TIMEOUT_MS) || 120_000;
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
      const seconds = Number(headers?.get?.('retry-after'));
      return {
        type: 'rate_limited',
        message: text.slice(0, 500),
        retryAfter: Number.isFinite(seconds) ? seconds * 1_000 : undefined,
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
