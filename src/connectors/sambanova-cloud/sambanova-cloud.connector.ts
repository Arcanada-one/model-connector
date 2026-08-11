import { randomUUID } from 'crypto';
import {
  CircuitBreakerResetEntry,
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  IConnector,
  ProviderModelMeta,
  classifyErrorAction,
} from '../interfaces/connector.interface';

const SAMBANOVA_CLOUD_BASE_URL = 'https://api.sambanova.ai/v1';
const CHAT_PATH = '/chat/completions' as const;
const MODELS_PATH = '/models' as const;
const DEFAULT_TIMEOUT_MS = 120_000;

export type SambaNovaPath = typeof CHAT_PATH | typeof MODELS_PATH;

export interface SambaNovaTransportRequest {
  method: 'GET' | 'POST';
  path: SambaNovaPath;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  timeoutMs: number;
}

export interface SambaNovaTransportResponse {
  status: number;
  body: unknown;
}

export interface SambaNovaTransport {
  request(input: SambaNovaTransportRequest): Promise<SambaNovaTransportResponse>;
}

export interface SambaNovaCloudConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

interface ParsedChat {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export class SambaNovaCloudConnector implements IConnector {
  readonly name = 'sambanova-cloud';
  readonly type = 'api' as const;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private modelMeta: ProviderModelMeta[] = [];
  private activeJobs = 0;

  constructor(
    config: SambaNovaCloudConfig,
    private readonly transport: SambaNovaTransport,
  ) {
    this.validateBaseUrl(config.baseUrl);
    this.apiKey = this.validateApiKey(config.apiKey);
    this.timeoutMs = this.validateTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const started = Date.now();
    const id = randomUUID();
    const validationError = this.validateRequest(request);
    if (validationError) return this.errorResponse(id, request, 'validation_error', validationError, 0);
    this.activeJobs++;
    try {
      const response = await this.transport.request({
        method: 'POST',
        path: CHAT_PATH,
        headers: this.headers(),
        body: this.buildChatBody(request),
        timeoutMs: request.timeout ?? this.timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) {
        const errorType = this.classifyStatus(response.status);
        return this.errorResponse(
          id,
          request,
          errorType,
          this.safeProviderMessage(response.body),
          Date.now() - started,
        );
      }
      return this.successResponse(id, request, this.parseChat(response.body), Date.now() - started);
    } catch {
      return this.errorResponse(
        id,
        request,
        'parse_error',
        'SambaNova Cloud response or transport was invalid',
        Date.now() - started,
      );
    } finally {
      this.activeJobs--;
    }
  }

  async *stream(request: ConnectorRequest): AsyncGenerator<string> {
    const validationError = this.validateRequest(request);
    if (validationError) throw new Error(validationError);

    this.activeJobs++;
    try {
      const response = await this.transport.request({
        method: 'POST',
        path: CHAT_PATH,
        headers: this.headers(),
        body: this.buildChatBody(request, true),
        timeoutMs: request.timeout ?? this.timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `SambaNova Cloud stream failed: ${this.classifyStatus(response.status)}: ${this.safeProviderMessage(response.body)}`,
        );
      }

      let buffer = '';
      let done = false;
      for await (const chunk of this.streamChunks(response.body)) {
        buffer += chunk;
        let boundary = this.eventBoundary(buffer);
        while (boundary) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const parsed = this.parseSseEvent(event);
          if (parsed.done) done = true;
          if (parsed.delta !== undefined) {
            if (done) throw new Error('SambaNova Cloud SSE contains data after DONE');
            yield parsed.delta;
          }
          boundary = this.eventBoundary(buffer);
        }
      }
      if (buffer.trim().length > 0) {
        const parsed = this.parseSseEvent(buffer);
        if (parsed.done) done = true;
        if (parsed.delta !== undefined) {
          if (done) throw new Error('SambaNova Cloud SSE contains data after DONE');
          yield parsed.delta;
        }
      }
      if (!done) throw new Error('SambaNova Cloud SSE ended without data: [DONE]');
    } finally {
      this.activeJobs--;
    }
  }

  async refreshModels(): Promise<void> {
    const response = await this.transport.request({
      method: 'GET',
      path: MODELS_PATH,
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`SambaNova Cloud model discovery failed with HTTP ${response.status}`);
    }
    const parsed = this.parseModels(response.body);
    this.modelMeta = parsed;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: this.type,
      models: this.modelMeta.map((model) => model.id),
      modelMeta: this.modelMeta.map((model) => ({ ...model })),
      supportsStreaming: true,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 300_000,
      modality: 'chat',
    };
  }

  async getStatus(): Promise<ConnectorStatus> {
    return {
      name: this.name,
      healthy: true,
      activeJobs: this.activeJobs,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    };
  }

  resetCircuitBreaker(_model?: string): CircuitBreakerResetEntry[] {
    return [];
  }

  private validateBaseUrl(value: string): void {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('SambaNova Cloud base URL is invalid');
    }
    if (
      value !== SAMBANOVA_CLOUD_BASE_URL ||
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'api.sambanova.ai' ||
      parsed.pathname !== '/v1' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('SambaNova Cloud base URL must equal the canonical hosted /v1 endpoint');
    }
  }

  private validateApiKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error('SambaNova Cloud API key must be non-empty');
    return trimmed;
  }

  private validateTimeout(value: number): number {
    if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
      throw new Error('SambaNova Cloud timeout must be an integer from 1000 to 300000 ms');
    }
    return value;
  }

  private validateRequest(request: ConnectorRequest): string | undefined {
    if (typeof request.model !== 'string' || request.model.trim().length === 0) {
      return 'SambaNova Cloud requests require a non-empty discovered model ID';
    }
    if (typeof request.prompt === 'string' && request.prompt.trim().length === 0) {
      return 'SambaNova Cloud requests require a non-empty prompt';
    }
    if (Array.isArray(request.prompt)) {
      if (request.prompt.length === 0) return 'SambaNova Cloud requests require content blocks';
      for (const block of request.prompt) {
        if (block.type === 'text' && block.text.trim().length === 0) {
          return 'SambaNova Cloud text content blocks must be non-empty';
        }
        if (
          block.type === 'image_url' &&
          !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/i.test(block.image_url.url)
        ) {
          return 'SambaNova Cloud image_url blocks require base64 image data URLs';
        }
      }
    }
    if (request.tools !== undefined) {
      return 'SambaNova Cloud native tools are not representable by the shared request contract';
    }
    if (request.timeout !== undefined && this.invalidNumber(request.timeout, 1_000, 300_000, true)) {
      return 'timeout must be an integer from 1000 to 300000';
    }
    const extra = request.extra ?? {};
    if (extra.max_tokens !== undefined && this.invalidNumber(extra.max_tokens, 1, 1_000_000, true)) {
      return 'max_tokens must be a positive integer';
    }
    if (extra.temperature !== undefined && this.invalidNumber(extra.temperature, 0, 1)) {
      return 'temperature must be between 0 and 1';
    }
    if (extra.top_p !== undefined && this.invalidNumber(extra.top_p, 0, 1)) {
      return 'top_p must be between 0 and 1';
    }
    if (extra.top_k !== undefined && this.invalidNumber(extra.top_k, 0, 1_000_000, true)) {
      return 'top_k must be a non-negative integer';
    }
    if (extra.stop !== undefined && !this.isStop(extra.stop)) return 'stop must be a string or string array';
    return undefined;
  }

  private invalidNumber(value: unknown, min: number, max: number, integer = false): boolean {
    return (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    );
  }

  private isStop(value: unknown): value is string | string[] {
    return (
      (typeof value === 'string' && value.length > 0) ||
      (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string'))
    );
  }

  private buildChatBody(request: ConnectorRequest, stream = false): Record<string, unknown> {
    const messages: Array<{ role: 'system' | 'user'; content: ConnectorRequest['prompt'] }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = { model: request.model, messages, stream };
    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'connector_response',
          strict: true,
          schema: request.jsonSchema,
        },
      };
    } else if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    for (const key of ['max_tokens', 'temperature', 'top_p', 'top_k', 'stop'] as const) {
      if (request.extra?.[key] !== undefined) body[key] = request.extra[key];
    }
    return body;
  }

  private async *streamChunks(value: unknown): AsyncGenerator<string> {
    if (typeof value === 'string') {
      yield value;
      return;
    }
    if (!this.isAsyncIterable(value)) throw new Error('SambaNova Cloud SSE body is not async iterable');
    const decoder = new TextDecoder();
    for await (const chunk of value) {
      if (typeof chunk === 'string') {
        yield chunk;
      } else if (chunk instanceof Uint8Array) {
        yield decoder.decode(chunk, { stream: true });
      } else {
        throw new Error('SambaNova Cloud SSE chunk must be text or bytes');
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  }

  private isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      Symbol.asyncIterator in value &&
      typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
    );
  }

  private eventBoundary(value: string): { index: number; length: number } | undefined {
    const match = /\r?\n\r?\n/.exec(value);
    return match ? { index: match.index, length: match[0].length } : undefined;
  }

  private parseSseEvent(value: string): { done?: boolean; delta?: string } {
    const dataLines = value
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith(':'))
      .map((line) => {
        if (!line.startsWith('data:')) throw new Error('SambaNova Cloud SSE must contain data-only events');
        return line.slice(5).replace(/^ /, '');
      });
    if (dataLines.length === 0) return {};
    const data = dataLines.join('\n');
    if (data === '[DONE]') return { done: true };

    const body = this.record(JSON.parse(data) as unknown);
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      throw new Error('SambaNova Cloud SSE event is missing choices');
    }
    const delta = this.record(this.record(body.choices[0]).delta);
    if (delta.content === undefined || delta.content === null) return {};
    if (typeof delta.content !== 'string') {
      throw new Error('SambaNova Cloud SSE delta content must be text');
    }
    return delta.content.length > 0 ? { delta: delta.content } : {};
  }

  private parseChat(value: unknown): ParsedChat {
    const body = this.record(value);
    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length === 0) throw new Error('missing choices');
    const choice = this.record(choices[0]);
    const message = this.record(choice.message);
    if (typeof message.content !== 'string') throw new Error('missing assistant content');
    if (typeof body.model !== 'string' || body.model.length === 0) throw new Error('missing model');
    const usage = body.usage === undefined ? {} : this.record(body.usage);
    return {
      text: message.content,
      model: body.model,
      inputTokens: this.nonNegativeInteger(usage.prompt_tokens),
      outputTokens: this.nonNegativeInteger(usage.completion_tokens),
    };
  }

  private parseModels(value: unknown): ProviderModelMeta[] {
    const body = this.record(value);
    if (body.object !== 'list' || !Array.isArray(body.data) || body.data.length === 0) {
      throw new Error('SambaNova Cloud model list is malformed');
    }
    const models = body.data.map((entry) => {
      const model = this.record(entry);
      if (typeof model.id !== 'string' || model.id.length === 0) {
        throw new Error('SambaNova Cloud model list contains an invalid ID');
      }
      return {
        id: model.id,
        modality: 'chat' as const,
        contextWindow: this.optionalPositiveInteger(model.context_length),
        maxOutputTokens: this.optionalPositiveInteger(model.max_completion_tokens),
      };
    });
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      throw new Error('SambaNova Cloud model list contains duplicate IDs');
    }
    return models;
  }

  private record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  }

  private nonNegativeInteger(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  }

  private optionalPositiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
  }

  private headers(): Readonly<Record<string, string>> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  private safeProviderMessage(value: unknown): string {
    try {
      const error = this.record(this.record(value).error);
      return typeof error.message === 'string' ? error.message.slice(0, 500) : 'SambaNova API error';
    } catch {
      return 'SambaNova API error';
    }
  }

  private classifyStatus(status: number): string {
    if (status === 401) return 'auth_error';
    if (status === 408) return 'timeout';
    if (status === 410) return 'model_not_found';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'validation_error';
  }

  private successResponse(
    id: string,
    request: ConnectorRequest,
    parsed: ParsedChat,
    latencyMs: number,
  ): ConnectorResponse {
    return {
      id,
      connector: this.name,
      model: parsed.model,
      result: parsed.text,
      usage: {
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        totalTokens: parsed.inputTokens + parsed.outputTokens,
        costUsd: 0,
      },
      latencyMs,
      queueWaitMs: 0,
      status: 'success',
    };
  }

  private errorResponse(
    id: string,
    request: ConnectorRequest,
    type: string,
    message: string,
    latencyMs: number,
  ): ConnectorResponse {
    const action = classifyErrorAction(type);
    return {
      id,
      connector: this.name,
      model: request.model ?? 'unknown',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs,
      queueWaitMs: 0,
      status: type === 'rate_limited' ? 'rate_limited' : type === 'timeout' ? 'timeout' : 'error',
      error: { type, message, ...action },
    };
  }
}
