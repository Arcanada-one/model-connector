import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

type OllamaCloudOperation = 'chat' | 'generate';

interface OllamaCloudResponse {
  model?: string;
  message?: { content?: string };
  response?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaCloudConnector extends BaseApiConnector {
  readonly name = 'ollama-cloud';

  protected getBaseUrl(): string {
    return 'https://ollama.com/api';
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OLLAMA_CLOUD_API_KEY || ''}`,
    };
  }

  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/tags`;
  }

  protected getStaticModels(): string[] {
    return [];
  }

  protected extractModels(json: unknown): ProviderModelMeta[] {
    const models = (json as { models?: unknown })?.models;
    if (!Array.isArray(models)) return [];

    return models
      .map((entry) => {
        const model = (entry as { model?: unknown }).model;
        return typeof model === 'string' ? model : undefined;
      })
      .filter((model): model is string => model != null && model.length > 0)
      .map((id) => ({ id }));
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/${this.getOperation(request)}`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') {
      throw new Error('ollama-cloud connector requires a string prompt');
    }

    const operation = this.getOperation(request);
    const common: Record<string, unknown> = {
      model: request.model,
      stream: false,
    };
    if (request.responseFormat?.type === 'json_object') common.format = 'json';

    const options = this.buildOptions(request.extra);
    if (Object.keys(options).length > 0) common.options = options;

    if (operation === 'generate') {
      return {
        ...common,
        prompt: request.prompt,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      };
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    return { ...common, messages };
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as OllamaCloudResponse;
    const operation = this.getOperation(request);
    const text = operation === 'generate' ? response.response : response.message?.content;

    return {
      text: text ?? '',
      model: response.model || request.model || 'unknown',
      inputTokens: response.prompt_eval_count ?? 0,
      outputTokens: response.eval_count ?? 0,
      costUsd: 0,
      isError: typeof response.error === 'string' || typeof text !== 'string',
      errorMessage: response.error || (typeof text === 'string' ? undefined : 'Missing response text'),
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: this.dynamicModels,
      modelMeta: this.dynamicModelMetas,
      modality: 'chat',
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }

  private getOperation(request: ConnectorRequest): OllamaCloudOperation {
    const operation = request.extra?.operation ?? 'chat';
    if (operation !== 'chat' && operation !== 'generate') {
      throw new Error(`Unsupported Ollama Cloud operation: ${String(operation)}`);
    }
    return operation;
  }

  private buildOptions(extra: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!extra) return {};
    const { operation: _operation, ...options } = extra;
    return options;
  }
}
