// CONN-0239 — orq.ai OpenAI-compatible gateway connector.
// Base: https://api.orq.ai/v2
// Chat:  POST /v2/proxy/chat/completions
// Models: GET /v2/models  → top-level JSON array (not {data:[]})
import { Logger } from '@nestjs/common';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

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

// /v2/models array entry — partial; only the fields we filter on.
interface OrqModelEntry {
  model_id: string;
  model_type: string; // 'chat' | 'image' | 'embedding' | 'rerank' | 'tts' | 'stt' | ...
  is_active: boolean;
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
  async refreshModels(): Promise<void> {
    try {
      const url = `${this.getBaseUrl()}/models`;
      const response = await fetch(url, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.warn(`orq /models returned ${response.status} — keeping seed list`);
        return;
      }

      const json = (await response.json()) as unknown;

      if (!Array.isArray(json)) {
        this.logger.warn('orq /models response is not an array — keeping seed list');
        return;
      }

      const ids: string[] = [];
      for (const entry of json as OrqModelEntry[]) {
        if (typeof entry?.model_id !== 'string') continue;
        if (entry.model_type === 'chat' && entry.is_active === true) {
          ids.push(entry.model_id);
        }
      }

      if (ids.length === 0) {
        this.logger.warn('orq /models yielded 0 chat+active models — keeping seed list');
        return;
      }

      this._dynamicModels = ids;
      this.logger.log(`orq model refresh: ${ids.length} chat models discovered`);
    } catch (err) {
      this.logger.warn(`orq model refresh failed: ${(err as Error).message} — keeping seed list`);
    }
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'orq',
      type: 'api',
      // Seed at boot (~3 models); replaced by ~421 after refreshModels().
      models: this._dynamicModels,
      // No freeModels — orq is a paid gateway with no per-call free tier.
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}
