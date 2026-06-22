import { Logger } from '@nestjs/common';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ContentBlock,
} from '../interfaces/connector.interface';

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

// CONN-0233 — OpenRouter /api/v1/models response shape (partial; only fields we use).
interface OpenRouterModelEntry {
  id: string;
  pricing?: { prompt?: string; completion?: string } | null;
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

  // CONN-0233 — cached free-model state populated by refreshFreeModels().
  // Starts empty; populated once on module init or on first catalog build.
  // A model is free when: pricing.prompt==="0" && pricing.completion==="0",
  // OR its id ends with ":free" (OpenRouter's self-documenting convention).
  private _dynamicFreeModels: string[] = [];
  private _dynamicModels: string[] = [...STATIC_MODELS];

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

      const freeIds: string[] = [];
      for (const entry of json.data) {
        if (typeof entry?.id !== 'string') continue;
        const isFreeById = entry.id.endsWith(':free');
        const isFreeByPricing =
          entry.pricing != null && entry.pricing.prompt === '0' && entry.pricing.completion === '0';
        if (isFreeById || isFreeByPricing) {
          freeIds.push(entry.id);
        }
      }

      this._dynamicFreeModels = freeIds;
      // Merge free models into the models list so the catalog service iterates them.
      // Static models remain; free models that aren't in the static list are appended.
      const staticSet = new Set(STATIC_MODELS);
      const extra = freeIds.filter((id) => !staticSet.has(id));
      this._dynamicModels = [...STATIC_MODELS, ...extra];

      this.logger.log(`OpenRouter free refresh: ${freeIds.length} free models discovered`);
    } catch (err) {
      this.logger.warn(
        `OpenRouter free refresh failed: ${(err as Error).message} — proceeding with empty freeModels`,
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
      // CONN-0233: _dynamicModels starts as STATIC_MODELS; after refreshFreeModels()
      // it is extended with discovered :free / pricing=0 models.
      models: this._dynamicModels,
      // CONN-0233: _dynamicFreeModels is empty until refreshFreeModels() runs.
      freeModels: this._dynamicFreeModels,
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}
