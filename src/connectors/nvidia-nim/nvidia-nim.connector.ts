import { randomUUID } from 'node:crypto';
import {
  type CircuitBreakerResetEntry,
  type ConnectorCapabilities,
  type ConnectorRequest,
  type ConnectorResponse,
  type ConnectorStatus,
  type IConnector,
  classifyErrorAction,
} from '../interfaces/connector.interface';

export type NvidiaNimDeploymentAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'header'; name: string; value: string };

export interface NvidiaNimConfig {
  baseUrl: string;
  model: string;
  auth: NvidiaNimDeploymentAuth;
  timeoutMs?: number;
}

export interface NvidiaNimTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  stream: boolean;
}

export interface NvidiaNimTransportResponse {
  status: number;
  body?: unknown;
}

export interface NvidiaNimTransport {
  send(request: NvidiaNimTransportRequest): Promise<NvidiaNimTransportResponse>;
}

export class NvidiaNimConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NvidiaNimConfigurationError';
  }
}

export class NvidiaNimStreamError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'NvidiaNimStreamError';
  }
}

interface ChatSuccessBody {
  id: string;
  model: string;
  choices: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'transfer-encoding',
]);

/**
 * Connector for an operator-owned NVIDIA NIM for LLMs runtime.
 *
 * The transport is mandatory by design. This class has no fetch/http client and
 * cannot perform a request unless its caller deliberately supplies an I/O boundary.
 * Authentication config describes the operator's deployment proxy, not an NVIDIA
 * hosted inference credential.
 */
export class NvidiaNimConnector implements IConnector {
  readonly name = 'nvidia-nim';
  readonly type = 'api' as const;

  private readonly baseUrl: URL;
  private readonly model: string;
  private readonly auth: NvidiaNimDeploymentAuth;
  private readonly timeoutMs: number;
  private activeJobs = 0;

  constructor(
    config: NvidiaNimConfig,
    private readonly transport: NvidiaNimTransport,
  ) {
    if (!transport || typeof transport.send !== 'function') {
      throw new NvidiaNimConfigurationError('An injected NVIDIA NIM transport is required');
    }
    this.baseUrl = NvidiaNimConnector.validateBaseUrl(config.baseUrl);
    this.model = NvidiaNimConnector.validateModel(config.model);
    this.auth = NvidiaNimConnector.validateAuth(config.auth);
    this.timeoutMs = NvidiaNimConnector.validateTimeout(config.timeoutMs);
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const requestError = this.validateRequest(request);
    if (requestError) return requestError;

    const startedAt = Date.now();
    this.activeJobs++;
    try {
      const response = await this.transport.send({
        method: 'POST',
        url: this.endpoint('/v1/chat/completions'),
        headers: this.headers(),
        body: this.chatBody(request, false),
        timeoutMs: request.timeout ?? this.timeoutMs,
        stream: false,
      });

      if (!NvidiaNimConnector.isHttpStatus(response.status)) {
        return this.errorResponse(
          request,
          'network_error',
          'Injected transport returned an invalid HTTP status',
          startedAt,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        const type = this.classifyHttpError(response.status, response.body);
        return this.errorResponse(
          request,
          type,
          this.safeErrorMessage(response.body),
          startedAt,
          response.status === 429 ? 'rate_limited' : 'error',
        );
      }

      const parsed = NvidiaNimConnector.parseChatSuccess(response.body);
      if (!parsed) {
        return this.errorResponse(
          request,
          'parse_error',
          'NVIDIA NIM returned a malformed chat completion payload',
          startedAt,
        );
      }

      const inputTokens = NvidiaNimConnector.nonNegativeNumber(parsed.usage?.prompt_tokens);
      const outputTokens = NvidiaNimConnector.nonNegativeNumber(parsed.usage?.completion_tokens);
      const reportedTotal = NvidiaNimConnector.nonNegativeNumber(parsed.usage?.total_tokens);
      return {
        id: parsed.id,
        connector: this.name,
        model: parsed.model,
        result: parsed.choices[0]?.message?.content ?? '',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: reportedTotal || inputTokens + outputTokens,
          costUsd: 0,
        },
        latencyMs: Date.now() - startedAt,
        status: 'success',
      };
    } catch (error) {
      const type = NvidiaNimConnector.isAbortError(error) ? 'timeout' : 'network_error';
      return this.errorResponse(
        request,
        type,
        type === 'timeout' ? 'NVIDIA NIM transport timed out' : 'NVIDIA NIM transport failed',
        startedAt,
        type === 'timeout' ? 'timeout' : 'error',
      );
    } finally {
      this.activeJobs--;
    }
  }

  async *stream(request: ConnectorRequest): AsyncGenerator<string> {
    const requestError = this.validateRequest(request);
    if (requestError) {
      throw new NvidiaNimStreamError(
        requestError.error?.type ?? 'validation_error',
        requestError.error?.message ?? 'Invalid NVIDIA NIM stream request',
      );
    }

    this.activeJobs++;
    try {
      const response = await this.transport.send({
        method: 'POST',
        url: this.endpoint('/v1/chat/completions'),
        headers: this.headers(),
        body: this.chatBody(request, true),
        timeoutMs: request.timeout ?? this.timeoutMs,
        stream: true,
      });
      if (!NvidiaNimConnector.isHttpStatus(response.status)) {
        throw new NvidiaNimStreamError(
          'network_error',
          'Injected transport returned an invalid HTTP status',
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new NvidiaNimStreamError(
          this.classifyHttpError(response.status, response.body),
          this.safeErrorMessage(response.body),
        );
      }

      let buffer = '';
      let done = false;
      for await (const transportChunk of NvidiaNimConnector.bodyChunks(response.body)) {
        buffer += transportChunk.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = NvidiaNimConnector.parseSseEvent(event);
          if (parsed.done) {
            done = true;
            break;
          }
          if (parsed.delta !== undefined) yield parsed.delta;
          boundary = buffer.indexOf('\n\n');
        }
        if (done) break;
      }
      if (!done && buffer.trim() !== '') {
        const parsed = NvidiaNimConnector.parseSseEvent(buffer);
        if (parsed.delta !== undefined) yield parsed.delta;
        done = parsed.done;
      }
      if (!done) {
        throw new NvidiaNimStreamError('parse_error', 'NVIDIA NIM stream ended before [DONE]');
      }
    } finally {
      this.activeJobs--;
    }
  }

  async getStatus(): Promise<ConnectorStatus> {
    try {
      const response = await this.transport.send({
        method: 'GET',
        url: this.endpoint('/v1/health/ready'),
        headers: this.headers(),
        timeoutMs: this.timeoutMs,
        stream: false,
      });
      return this.status(response.status === 200);
    } catch {
      return this.status(false);
    }
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: this.type,
      models: [this.model],
      modelMeta: [{ id: this.model, modality: 'chat' }],
      modality: 'chat',
      supportsStreaming: true,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: this.timeoutMs,
    };
  }

  resetCircuitBreaker(_model?: string): CircuitBreakerResetEntry[] {
    return [];
  }

  private endpoint(path: '/v1/chat/completions' | '/v1/health/ready'): string {
    const url = new URL(this.baseUrl.toString());
    const prefix = url.pathname.replace(/\/+$/, '');
    url.pathname = `${prefix}${path}`;
    return url.toString();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.auth.type === 'bearer') headers.Authorization = `Bearer ${this.auth.token}`;
    if (this.auth.type === 'header') headers[this.auth.name] = this.auth.value;
    return headers;
  }

  private chatBody(request: ConnectorRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt as string });
    const body: Record<string, unknown> = { model: this.model, messages };
    if (stream) body.stream = true;
    for (const field of ['max_tokens', 'temperature', 'top_p'] as const) {
      const value = request.extra?.[field];
      if (value !== undefined) body[field] = value;
    }
    return body;
  }

  private validateRequest(request: ConnectorRequest): ConnectorResponse | undefined {
    if (typeof request.prompt !== 'string') {
      return this.errorResponse(
        request,
        'unsupported_modality',
        'NVIDIA NIM AU-019 accepts string chat prompts only',
      );
    }
    if (request.model !== undefined && request.model !== this.model) {
      return this.errorResponse(
        request,
        'model_not_found',
        `Requested model does not match configured NVIDIA NIM model '${this.model}'`,
      );
    }
    if (request.timeout !== undefined && !NvidiaNimConnector.isValidTimeout(request.timeout)) {
      return this.errorResponse(request, 'validation_error', 'Request timeout is out of range');
    }
    const maxTokens = request.extra?.max_tokens;
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) <= 0)) {
      return this.errorResponse(request, 'validation_error', 'max_tokens must be a positive integer');
    }
    const temperature = request.extra?.temperature;
    if (
      temperature !== undefined &&
      (typeof temperature !== 'number' || temperature < 0 || temperature > 2)
    ) {
      return this.errorResponse(request, 'validation_error', 'temperature must be between 0 and 2');
    }
    const topP = request.extra?.top_p;
    if (topP !== undefined && (typeof topP !== 'number' || topP < 0 || topP > 1)) {
      return this.errorResponse(request, 'validation_error', 'top_p must be between 0 and 1');
    }
    return undefined;
  }

  private classifyHttpError(status: number, body: unknown): string {
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 429) return 'rate_limited';
    if (status === 404 && NvidiaNimConnector.isModelNotFound(body)) return 'model_not_found';
    if (status >= 500) return 'server_error';
    return 'http_error';
  }

  private safeErrorMessage(body: unknown): string {
    let message = 'NVIDIA NIM deployment returned an error';
    if (typeof body === 'string') {
      message = body;
    } else if (NvidiaNimConnector.isRecord(body)) {
      const nested = NvidiaNimConnector.isRecord(body.error) ? body.error.message : undefined;
      if (typeof nested === 'string') message = nested;
    }
    const secrets =
      this.auth.type === 'none'
        ? []
        : [this.auth.type === 'bearer' ? this.auth.token : this.auth.value];
    for (const secret of secrets) {
      if (secret !== '') message = message.split(secret).join('[REDACTED]');
    }
    return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
  }

  private errorResponse(
    request: ConnectorRequest,
    type: string,
    message: string,
    startedAt = Date.now(),
    status: ConnectorResponse['status'] = 'error',
  ): ConnectorResponse {
    return {
      id: randomUUID(),
      connector: this.name,
      model: request.model ?? this.model,
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: Math.max(0, Date.now() - startedAt),
      status,
      error: { type, message, ...classifyErrorAction(type) },
    };
  }

  private status(healthy: boolean): ConnectorStatus {
    return {
      name: this.name,
      healthy,
      activeJobs: this.activeJobs,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    };
  }

  private static validateBaseUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new NvidiaNimConfigurationError('NVIDIA NIM base URL must be absolute');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new NvidiaNimConfigurationError('NVIDIA NIM base URL must use HTTP or HTTPS');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new NvidiaNimConfigurationError(
        'NVIDIA NIM base URL cannot contain credentials, query, or fragment',
      );
    }
    return url;
  }

  private static validateModel(value: string): string {
    if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new NvidiaNimConfigurationError('NVIDIA NIM model must be a non-empty identifier');
    }
    return value;
  }

  private static validateAuth(auth: NvidiaNimDeploymentAuth): NvidiaNimDeploymentAuth {
    if (!auth || typeof auth !== 'object') {
      throw new NvidiaNimConfigurationError('NVIDIA NIM deployment auth must be explicit');
    }
    if (auth.type === 'none') return auth;
    if (auth.type === 'bearer') {
      if (typeof auth.token !== 'string' || auth.token.trim() === '') {
        throw new NvidiaNimConfigurationError('Bearer deployment auth requires a token');
      }
      return auth;
    }
    if (auth.type === 'header') {
      const lowerName = auth.name.toLowerCase();
      if (
        !HEADER_NAME.test(auth.name) ||
        FORBIDDEN_CUSTOM_HEADERS.has(lowerName) ||
        typeof auth.value !== 'string' ||
        auth.value.trim() === '' ||
        /[\r\n]/.test(auth.value)
      ) {
        throw new NvidiaNimConfigurationError('Invalid custom deployment-auth header');
      }
      return auth;
    }
    throw new NvidiaNimConfigurationError('Unsupported NVIDIA NIM deployment auth mode');
  }

  private static validateTimeout(value: number | undefined): number {
    const timeout = value ?? DEFAULT_TIMEOUT_MS;
    if (!NvidiaNimConnector.isValidTimeout(timeout)) {
      throw new NvidiaNimConfigurationError(
        `NVIDIA NIM timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms`,
      );
    }
    return timeout;
  }

  private static isValidTimeout(value: number): boolean {
    return Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS;
  }

  private static parseChatSuccess(body: unknown): ChatSuccessBody | undefined {
    if (!NvidiaNimConnector.isRecord(body)) return undefined;
    if (typeof body.id !== 'string' || typeof body.model !== 'string') return undefined;
    if (!Array.isArray(body.choices) || body.choices.length === 0) return undefined;
    const first = body.choices[0];
    if (!NvidiaNimConnector.isRecord(first) || !NvidiaNimConnector.isRecord(first.message)) {
      return undefined;
    }
    const content = first.message.content;
    if (content !== null && typeof content !== 'string') return undefined;
    return body as unknown as ChatSuccessBody;
  }

  private static isModelNotFound(body: unknown): boolean {
    if (!NvidiaNimConnector.isRecord(body) || !NvidiaNimConnector.isRecord(body.error)) {
      return false;
    }
    const code = body.error.code;
    const message = body.error.message;
    return code === 'model_not_found' ||
      (typeof message === 'string' && /model[^a-z]*not[^a-z]*(found|exist)/i.test(message));
  }

  private static parseSseEvent(event: string): { done: boolean; delta?: string } {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '') return { done: false };
    if (data === '[DONE]') return { done: true };
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      throw new NvidiaNimStreamError('parse_error', 'NVIDIA NIM stream contained invalid JSON');
    }
    if (!NvidiaNimConnector.isRecord(parsed) || !Array.isArray(parsed.choices)) {
      throw new NvidiaNimStreamError('parse_error', 'NVIDIA NIM stream chunk was malformed');
    }
    const first = parsed.choices[0];
    if (!NvidiaNimConnector.isRecord(first) || !NvidiaNimConnector.isRecord(first.delta)) {
      throw new NvidiaNimStreamError('parse_error', 'NVIDIA NIM stream delta was malformed');
    }
    const content = first.delta.content;
    if (content === undefined) return { done: false };
    if (typeof content !== 'string') {
      throw new NvidiaNimStreamError('parse_error', 'NVIDIA NIM stream content was not text');
    }
    return { done: false, delta: content };
  }

  private static async *bodyChunks(body: unknown): AsyncGenerator<string> {
    if (typeof body === 'string') {
      yield body;
      return;
    }
    if (NvidiaNimConnector.isAsyncIterable(body)) {
      for await (const chunk of body) {
        if (typeof chunk !== 'string') {
          throw new NvidiaNimStreamError('parse_error', 'NVIDIA NIM transport emitted non-text SSE');
        }
        yield chunk;
      }
      return;
    }
    throw new NvidiaNimStreamError('parse_error', 'NVIDIA NIM transport did not return SSE text');
  }

  private static isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      Symbol.asyncIterator in value &&
      typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
    );
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static isHttpStatus(value: number): boolean {
    return Number.isInteger(value) && value >= 100 && value <= 599;
  }

  private static nonNegativeNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private static isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }
}
