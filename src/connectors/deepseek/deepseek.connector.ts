import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

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

  protected parseResponse(
    json: DeepSeekChatResponse,
    request: ConnectorRequest,
  ): ParsedApiOutput {
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
    return {
      text: message.content || '',
      structured: {
        ...(message.reasoning_content != null
          ? { reasoning_content: message.reasoning_content }
          : {}),
        usage: {
          prompt_cache_hit_tokens: usage?.prompt_cache_hit_tokens ?? 0,
          prompt_cache_miss_tokens: usage?.prompt_cache_miss_tokens ?? 0,
        },
      },
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      costUsd: 0,
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
