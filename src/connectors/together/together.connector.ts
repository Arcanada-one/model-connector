import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

interface TogetherChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface TogetherModelEntry {
  id?: unknown;
  type?: unknown;
  context_length?: unknown;
}

const DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

export class TogetherConnector extends BaseApiConnector {
  readonly name = 'together';

  protected getBaseUrl(): string {
    return 'https://api.together.xyz/v1';
  }

  protected getStaticModels(): string[] {
    return [DEFAULT_MODEL];
  }

  protected getStaticModelMetas(): ProviderModelMeta[] {
    return [{ id: DEFAULT_MODEL, modality: 'chat' }];
  }

  protected extractModels(json: unknown): ProviderModelMeta[] {
    if (!Array.isArray(json)) return [];
    return json.flatMap((entry) => {
      const model = entry as TogetherModelEntry;
      if (typeof model.id !== 'string' || model.id.length === 0 || model.type !== 'chat') return [];
      return [{
        id: model.id,
        modality: 'chat' as const,
        contextWindow: typeof model.context_length === 'number' ? model.context_length : null,
      }];
    });
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TOGETHER_API_KEY || ''}`,
    };
  }

  protected getTimeout(): number {
    return Number(process.env.TOGETHER_TIMEOUT_MS) || 120_000;
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') throw new Error('together connector requires string prompt');
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = { model: request.model || DEFAULT_MODEL, messages };
    for (const key of ['max_tokens', 'temperature', 'top_p'] as const) {
      if (request.extra?.[key] != null) body[key] = request.extra[key];
    }
    return body;
  }

  protected parseResponse(json: TogetherChatResponse, request: ConnectorRequest): ParsedApiOutput {
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { text: '', model: json.model || request.model || DEFAULT_MODEL, inputTokens: 0,
        outputTokens: 0, costUsd: 0, isError: true, errorMessage: 'No message content in response' };
    }
    return {
      text: content,
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map((model) => model.id),
      modelMeta,
      freeModels: [],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }
}
