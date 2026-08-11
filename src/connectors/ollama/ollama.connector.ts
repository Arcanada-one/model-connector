import { Injectable } from '@nestjs/common';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

interface OllamaChatResponse {
  model?: string;
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

@Injectable()
export class OllamaConnector extends BaseApiConnector {
  readonly name = 'ollama';

  protected getBaseUrl(): string {
    const raw = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const url = new URL(raw);
    if (url.username || url.password) throw new Error('OLLAMA_BASE_URL must not contain userinfo');
    if (url.hostname === 'ollama.com' || url.hostname.endsWith('.ollama.com')) {
      throw new Error('Ollama Cloud is outside the ollama local connector boundary');
    }
    return url
      .toString()
      .replace(/\/$/, '')
      .replace(/\/api$/, '');
  }

  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/api/tags`;
  }

  protected extractModels(json: unknown): ProviderModelMeta[] {
    const models = (json as { models?: unknown })?.models;
    if (!Array.isArray(models)) return [];
    return models
      .map((entry) => {
        const model = entry as { name?: unknown; model?: unknown };
        const id = typeof model.name === 'string' ? model.name : model.model;
        return typeof id === 'string' && id.length > 0 ? { id } : null;
      })
      .filter((model): model is ProviderModelMeta => model !== null);
  }

  protected buildRequestUrl(): string {
    return `${this.getBaseUrl()}/api/chat`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string')
      throw new Error('ollama connector requires string prompt');
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = {
      model: request.model || process.env.OLLAMA_DEFAULT_MODEL || 'llama3.2',
      messages,
      stream: false,
    };
    if (request.jsonSchema) body.format = request.jsonSchema;
    if (request.responseFormat?.type === 'json_object') body.format = 'json';
    if (request.extra?.options) body.options = request.extra.options;
    return body;
  }

  protected parseResponse(json: OllamaChatResponse, request: ConnectorRequest): ParsedApiOutput {
    return {
      text: json.message?.content || '',
      model: json.model || request.model || process.env.OLLAMA_DEFAULT_MODEL || 'llama3.2',
      inputTokens: json.prompt_eval_count ?? 0,
      outputTokens: json.eval_count ?? 0,
      costUsd: 0,
      isError: Boolean(json.error),
      errorMessage: json.error,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    this.getBaseUrl();
    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map((model) => model.id),
      modelMeta,
      freeModels: modelMeta.map((model) => model.id),
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 600_000,
    };
  }

  showModel(model: string): Promise<unknown> {
    return this.lifecycle('/api/show', 'POST', { model });
  }

  pullModel(model: string): Promise<unknown> {
    return this.lifecycle('/api/pull', 'POST', { model, stream: false });
  }

  deleteModel(model: string): Promise<unknown> {
    return this.lifecycle('/api/delete', 'DELETE', { model });
  }

  listRunningModels(): Promise<unknown> {
    return this.lifecycle('/api/ps', 'GET');
  }

  getVersion(): Promise<unknown> {
    return this.lifecycle('/api/version', 'GET');
  }

  private async lifecycle(path: string, method: string, body?: object): Promise<unknown> {
    const response = await fetch(`${this.getBaseUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS) || 300_000),
    });
    if (!response.ok) throw new Error(`Ollama local ${path} returned HTTP ${response.status}`);
    return response.json();
  }
}
