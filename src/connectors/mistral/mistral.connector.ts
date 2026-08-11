import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

interface MistralResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_MODEL = 'mistral-small-latest';
const STATIC_MODELS: ProviderModelMeta[] = [
  { id: 'mistral-large-latest', modality: 'chat', free: false },
  { id: DEFAULT_MODEL, modality: 'chat', free: false },
];

export class MistralConnector extends BaseApiConnector {
  readonly name = 'mistral';

  protected getBaseUrl(): string {
    return 'https://api.mistral.ai/v1';
  }
  protected getStaticModels(): string[] {
    return STATIC_MODELS.map(({ id }) => id);
  }
  protected getStaticModelMetas(): ProviderModelMeta[] {
    return STATIC_MODELS;
  }
  protected getTimeout(): number {
    return Number(process.env.MISTRAL_TIMEOUT_MS) || 120_000;
  }
  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY || ''}`,
    };
  }
  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string')
      throw new Error('mistral connector requires string prompt');
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = { model: request.model || DEFAULT_MODEL, messages };
    if (request.responseFormat?.type === 'json_object')
      body.response_format = { type: 'json_object' };
    for (const key of ['max_tokens', 'temperature', 'top_p'] as const) {
      if (request.extra?.[key] != null) body[key] = request.extra[key];
    }
    return body;
  }

  protected parseResponse(json: MistralResponse, request: ConnectorRequest): ParsedApiOutput {
    const choice = json.choices?.[0];
    if (!choice)
      return {
        text: '',
        model: json.model || request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No choices in Mistral response',
      };
    return {
      text: choice.message?.content || '',
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      costUsd: 0,
      isError: false,
    };
  }

  protected extractModels(json: unknown): ProviderModelMeta[] {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    return data.flatMap((raw): ProviderModelMeta[] => {
      const card = raw as {
        id?: unknown;
        archived?: unknown;
        max_context_length?: unknown;
        capabilities?: { completion_chat?: unknown; vision?: unknown };
      };
      if (
        typeof card.id !== 'string' ||
        card.archived === true ||
        card.capabilities?.completion_chat !== true
      )
        return [];
      return [
        {
          id: card.id,
          modality: 'chat',
          free: false,
          contextWindow:
            typeof card.max_context_length === 'number' ? card.max_context_length : null,
        },
      ];
    });
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map(({ id }) => id),
      modelMeta,
      freeModels: [],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }
}
