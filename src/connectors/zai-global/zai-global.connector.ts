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

const ZAI_GLOBAL_BASE_URL = 'https://api.z.ai/api/paas/v4';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const CHAT_PATH = '/chat/completions' as const;
const IMAGE_PATH = '/images/generations' as const;
const ASYNC_IMAGE_PATH = '/async/images/generations' as const;
const VIDEO_PATH = '/videos/generations' as const;
const AUDIO_PATH = '/audio/transcriptions' as const;
const TOKENIZER_PATH = '/tokenizer' as const;
const LAYOUT_PATH = '/layout_parsing' as const;
const SEARCH_PATH = '/web_search' as const;
const READER_PATH = '/reader' as const;

const CHAT_MODELS = [
  'glm-5.2',
  'glm-5.1',
  'glm-5-turbo',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'glm-4.7-flashx',
  'glm-4.6',
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.5-x',
  'glm-4.5-airx',
  'glm-4.5-flash',
  'glm-4-32b-0414-128k',
] as const;

type StaticZaiGlobalPath =
  | typeof CHAT_PATH
  | typeof IMAGE_PATH
  | typeof ASYNC_IMAGE_PATH
  | typeof VIDEO_PATH
  | typeof AUDIO_PATH
  | typeof TOKENIZER_PATH
  | typeof LAYOUT_PATH
  | typeof SEARCH_PATH
  | typeof READER_PATH;

export type ZaiGlobalPath = StaticZaiGlobalPath | `/async-result/${string}`;

export interface ZaiGlobalTransportRequest {
  method: 'GET' | 'POST';
  path: ZaiGlobalPath;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  contentType?: 'application/json' | 'multipart/form-data';
  stream?: boolean;
  timeoutMs: number;
}

export interface ZaiGlobalTransportResponse {
  status: number;
  body: unknown;
}

export interface ZaiGlobalTransport {
  request(input: ZaiGlobalTransportRequest): Promise<ZaiGlobalTransportResponse>;
}

export interface ZaiGlobalConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface ZaiAudioFile {
  filename: string;
  contentType: 'audio/wav' | 'audio/mpeg';
  data: Uint8Array;
}

export interface ZaiAudioTranscriptionRequest {
  model: string;
  file?: ZaiAudioFile;
  fileBase64?: string;
  prompt?: string;
  hotwords?: string[];
  requestId?: string;
  userId?: string;
}

interface ParsedChat {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface SafeProviderError {
  type: string;
  message: string;
}

export class ZaiGlobalConnector implements IConnector {
  readonly name = 'zai-global';
  readonly type = 'api' as const;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private activeJobs = 0;

  constructor(
    config: ZaiGlobalConfig,
    private readonly transport: ZaiGlobalTransport,
  ) {
    this.validateBaseUrl(config.baseUrl);
    this.apiKey = this.validateApiKey(config.apiKey);
    this.timeoutMs = this.validateTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const id = randomUUID();
    const started = Date.now();
    const validationError = this.validateChatRequest(request);
    if (validationError) return this.errorResponse(id, request, 'validation_error', validationError, 0);

    this.activeJobs++;
    try {
      const response = await this.send({
        method: 'POST',
        path: CHAT_PATH,
        body: this.buildChatBody(request, false),
        contentType: 'application/json',
        stream: false,
        timeoutMs: request.timeout ?? this.timeoutMs,
      });
      if (!this.isSuccess(response.status)) {
        const error = this.safeProviderError(response.status, response.body);
        return this.errorResponse(id, request, error.type, error.message, Date.now() - started);
      }
      try {
        return this.successResponse(
          id,
          request,
          this.parseChat(response.body, request),
          Date.now() - started,
        );
      } catch {
        return this.errorResponse(
          id,
          request,
          'parse_error',
          'Z.AI success response was malformed',
          Date.now() - started,
        );
      }
    } catch {
      return this.errorResponse(
        id,
        request,
        'network_error',
        'Z.AI transport failed',
        Date.now() - started,
      );
    } finally {
      this.activeJobs--;
    }
  }

  async *streamChat(request: ConnectorRequest): AsyncGenerator<string> {
    const validationError = this.validateChatRequest(request);
    if (validationError) throw new Error(validationError);
    yield* this.streamOperation(
      {
        method: 'POST',
        path: CHAT_PATH,
        body: this.buildChatBody(request, true),
        contentType: 'application/json',
        stream: true,
        timeoutMs: request.timeout ?? this.timeoutMs,
      },
      (event) => this.chatDelta(event),
    );
  }

  generateImage(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'model', 'prompt');
    return this.postJson(IMAGE_PATH, input);
  }

  generateImageAsync(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'model', 'prompt');
    return this.postJson(ASYNC_IMAGE_PATH, input);
  }

  generateVideo(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'model');
    if (!this.nonEmptyString(input.prompt) && input.image_url === undefined) {
      throw new Error('Z.AI video generation requires prompt or image_url');
    }
    return this.postJson(VIDEO_PATH, input);
  }

  async getAsyncResult(id: string): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Z.AI async task ID is invalid');
    return this.requestNative({
      method: 'GET',
      path: `/async-result/${id}`,
      timeoutMs: this.timeoutMs,
    });
  }

  async transcribe(input: ZaiAudioTranscriptionRequest): Promise<Record<string, unknown>> {
    return this.requestNative(this.audioTransportRequest(input, false));
  }

  async *streamTranscription(input: ZaiAudioTranscriptionRequest): AsyncGenerator<string> {
    yield* this.streamOperation(this.audioTransportRequest(input, true), (event) =>
      this.audioDelta(event),
    );
  }

  tokenize(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'model');
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new Error('Z.AI tokenizer requires messages');
    }
    return this.postJson(TOKENIZER_PATH, input);
  }

  parseLayout(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'model', 'file');
    return this.postJson(LAYOUT_PATH, input);
  }

  webSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'search_engine', 'search_query');
    return this.postJson(SEARCH_PATH, input);
  }

  readWeb(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'url');
    this.validatePublicUrl(input.url as string, 'reader URL');
    return this.postJson(READER_PATH, input);
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta: ProviderModelMeta[] = CHAT_MODELS.map((id) => ({ id, modality: 'chat' }));
    return {
      name: this.name,
      type: this.type,
      models: [...CHAT_MODELS],
      modelMeta,
      supportsStreaming: true,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: MAX_TIMEOUT_MS,
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

  private async postJson(
    path: StaticZaiGlobalPath,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestNative({
      method: 'POST',
      path,
      body,
      contentType: 'application/json',
      timeoutMs: this.timeoutMs,
    });
  }

  private async requestNative(
    input: Omit<ZaiGlobalTransportRequest, 'headers'>,
  ): Promise<Record<string, unknown>> {
    let response: ZaiGlobalTransportResponse;
    try {
      response = await this.send(input);
    } catch {
      throw new Error('Z.AI transport failed');
    }
    if (!this.isSuccess(response.status)) {
      const error = this.safeProviderError(response.status, response.body);
      throw new Error(`${error.type}: ${error.message}`);
    }
    try {
      return this.record(response.body);
    } catch {
      throw new Error('Z.AI success response was malformed');
    }
  }

  private async *streamOperation(
    input: Omit<ZaiGlobalTransportRequest, 'headers'>,
    extractDelta: (event: unknown) => string | undefined,
  ): AsyncGenerator<string> {
    this.activeJobs++;
    try {
      const response = await this.send(input);
      if (!this.isSuccess(response.status)) {
        const error = this.safeProviderError(response.status, response.body);
        throw new Error(`${error.type}: ${error.message}`);
      }
      yield* this.decodeSse(response.body, extractDelta);
    } finally {
      this.activeJobs--;
    }
  }

  private async *decodeSse(
    body: unknown,
    extractDelta: (event: unknown) => string | undefined,
  ): AsyncGenerator<string> {
    let buffer = '';
    let done = false;
    for await (const chunk of this.streamChunks(body)) {
      buffer += chunk;
      let boundary = this.eventBoundary(buffer);
      while (boundary) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const result = this.parseSseEvent(event, extractDelta);
        if (done && (result.done || result.delta !== undefined)) {
          throw new Error('Z.AI SSE contains data after DONE');
        }
        if (result.done) done = true;
        if (result.delta !== undefined) yield result.delta;
        boundary = this.eventBoundary(buffer);
      }
    }
    if (buffer.trim().length > 0) {
      const result = this.parseSseEvent(buffer, extractDelta);
      if (done && (result.done || result.delta !== undefined)) {
        throw new Error('Z.AI SSE contains data after DONE');
      }
      if (result.done) done = true;
      if (result.delta !== undefined) yield result.delta;
    }
    if (!done) throw new Error('Z.AI SSE ended without data: [DONE]');
  }

  private parseSseEvent(
    event: string,
    extractDelta: (value: unknown) => string | undefined,
  ): { done?: boolean; delta?: string } {
    const lines = event.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith(':'));
    if (lines.length === 0) return {};
    const data = lines
      .map((line) => {
        if (!line.startsWith('data:')) throw new Error('Z.AI SSE must contain data-only events');
        return line.slice(5).replace(/^ /, '');
      })
      .join('\n');
    if (data === '[DONE]') return { done: true };
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      throw new Error('Z.AI SSE data is not valid JSON');
    }
    const delta = extractDelta(parsed);
    return delta === undefined || delta.length === 0 ? {} : { delta };
  }

  private chatDelta(value: unknown): string | undefined {
    const body = this.record(value);
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      throw new Error('Z.AI chat SSE event is missing choices');
    }
    const delta = this.record(this.record(body.choices[0]).delta);
    if (delta.content === undefined || delta.content === null) return undefined;
    if (typeof delta.content !== 'string') throw new Error('Z.AI chat SSE delta must be text');
    return delta.content;
  }

  private audioDelta(value: unknown): string | undefined {
    const body = this.record(value);
    if (body.type !== 'transcript.text.delta' && body.type !== 'transcript.text.done') {
      throw new Error('Z.AI audio SSE event type is invalid');
    }
    if (body.delta === undefined || body.delta === null) return undefined;
    if (typeof body.delta !== 'string') throw new Error('Z.AI audio SSE delta must be text');
    return body.delta;
  }

  private async *streamChunks(value: unknown): AsyncGenerator<string> {
    if (typeof value === 'string') {
      yield value;
      return;
    }
    if (!this.isAsyncIterable(value)) throw new Error('Z.AI SSE body is not async iterable');
    const decoder = new TextDecoder();
    for await (const chunk of value) {
      if (typeof chunk === 'string') yield chunk;
      else if (chunk instanceof Uint8Array) yield decoder.decode(chunk, { stream: true });
      else throw new Error('Z.AI SSE chunk must be text or bytes');
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

  private audioTransportRequest(
    input: ZaiAudioTranscriptionRequest,
    stream: boolean,
  ): Omit<ZaiGlobalTransportRequest, 'headers'> {
    this.validateAudioRequest(input);
    const body: Record<string, unknown> = { model: input.model, stream };
    if (input.file) body.file = input.file;
    if (input.fileBase64) body.file_base64 = input.fileBase64;
    if (input.prompt !== undefined) body.prompt = input.prompt;
    if (input.hotwords !== undefined) body.hotwords = input.hotwords;
    if (input.requestId !== undefined) body.request_id = input.requestId;
    if (input.userId !== undefined) body.user_id = input.userId;
    return {
      method: 'POST',
      path: AUDIO_PATH,
      body,
      contentType: 'multipart/form-data',
      stream,
      timeoutMs: this.timeoutMs,
    };
  }

  private validateAudioRequest(input: ZaiAudioTranscriptionRequest): void {
    if (input.model !== 'glm-asr-2512') throw new Error('Z.AI audio model must be glm-asr-2512');
    if (!input.file && !this.nonEmptyString(input.fileBase64)) {
      throw new Error('Z.AI audio transcription requires file or file_base64');
    }
    if (input.file) {
      if (!/\.(wav|mp3)$/i.test(input.file.filename)) throw new Error('Z.AI audio file must be wav or mp3');
      if (input.file.data.byteLength === 0 || input.file.data.byteLength > MAX_AUDIO_BYTES) {
        throw new Error('Z.AI audio file must be between 1 byte and 25 MB');
      }
    }
    if (input.hotwords && (input.hotwords.length > 100 || !input.hotwords.every(this.nonEmptyString))) {
      throw new Error('Z.AI audio hotwords must contain at most 100 non-empty strings');
    }
  }

  private validateChatRequest(request: ConnectorRequest): string | undefined {
    if (!this.nonEmptyString(request.model)) return 'Z.AI chat requires a non-empty model';
    if (request.tools !== undefined) return 'Z.AI native tools are not representable by tools:string[]';
    if (request.jsonSchema !== undefined) return 'Z.AI global API does not document json_schema';
    if (request.timeout !== undefined && this.invalidNumber(request.timeout, 1_000, MAX_TIMEOUT_MS, true)) {
      return 'Z.AI timeout must be an integer from 1000 to 300000 ms';
    }
    if (typeof request.prompt === 'string') {
      if (request.prompt.trim().length === 0) return 'Z.AI chat requires a non-empty prompt';
    } else if (!this.validContentBlocks(request.prompt)) {
      return 'Z.AI chat content blocks are invalid';
    }
    return this.validateChatExtra(request.extra);
  }

  private validateChatExtra(extra: Record<string, unknown> | undefined): string | undefined {
    if (!extra) return undefined;
    const allowed = new Set([
      'max_tokens',
      'temperature',
      'top_p',
      'do_sample',
      'stop',
      'thinking',
      'request_id',
      'user_id',
    ]);
    if (Object.keys(extra).some((key) => !allowed.has(key))) return 'Z.AI chat extra field is unsupported';
    if (extra.max_tokens !== undefined && this.invalidNumber(extra.max_tokens, 1, 1_000_000, true)) {
      return 'Z.AI max_tokens must be a positive integer';
    }
    if (extra.temperature !== undefined && this.invalidNumber(extra.temperature, 0, 1)) {
      return 'Z.AI temperature must be between 0 and 1';
    }
    if (extra.top_p !== undefined && this.invalidNumber(extra.top_p, 0, 1)) {
      return 'Z.AI top_p must be between 0 and 1';
    }
    return undefined;
  }

  private validContentBlocks(prompt: ConnectorRequest['prompt']): boolean {
    if (!Array.isArray(prompt) || prompt.length === 0) return false;
    return prompt.every((block) => {
      if (block.type === 'text') return block.text.trim().length > 0;
      const url = block.image_url.url;
      if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/i.test(url)) return true;
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
      } catch {
        return false;
      }
    });
  }

  private buildChatBody(request: ConnectorRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<{ role: 'system' | 'user'; content: ConnectorRequest['prompt'] }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = { model: request.model, messages, stream };
    if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    for (const [key, value] of Object.entries(request.extra ?? {})) body[key] = value;
    return body;
  }

  private parseChat(value: unknown, _request: ConnectorRequest): ParsedChat {
    const body = this.record(value);
    if (!Array.isArray(body.choices) || body.choices.length === 0) throw new Error('missing choices');
    const message = this.record(this.record(body.choices[0]).message);
    if (typeof message.content !== 'string') throw new Error('missing assistant content');
    if (!this.nonEmptyString(body.model)) throw new Error('missing model');
    const usage = body.usage === undefined ? {} : this.record(body.usage);
    const inputTokens = this.nonNegativeInteger(usage.prompt_tokens);
    const outputTokens = this.nonNegativeInteger(usage.completion_tokens);
    const providerTotal = this.nonNegativeInteger(usage.total_tokens);
    return {
      text: message.content,
      model: body.model,
      inputTokens,
      outputTokens,
      totalTokens: providerTotal || inputTokens + outputTokens,
    };
  }

  private async send(
    input: Omit<ZaiGlobalTransportRequest, 'headers'>,
  ): Promise<ZaiGlobalTransportResponse> {
    return this.transport.request({ ...input, headers: this.headers(input.contentType) });
  }

  private headers(contentType?: ZaiGlobalTransportRequest['contentType']): Readonly<Record<string, string>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Accept-Language': 'en-US,en',
    };
    if (contentType === 'application/json') headers['Content-Type'] = 'application/json';
    return headers;
  }

  private safeProviderError(status: number, value: unknown): SafeProviderError {
    const code = this.providerCode(value);
    const suffix = code === undefined ? '' : `, code ${code}`;
    return {
      type: this.classifyProviderError(status, code),
      message: `Z.AI request failed (HTTP ${status}${suffix})`,
    };
  }

  private classifyProviderError(status: number, code?: number): string {
    if ([1000, 1001, 1003, 1005, 1220].includes(code ?? -1) || status === 401 || status === 403) {
      return 'auth_error';
    }
    if (code === 1113) return 'billing_error';
    if ([1302, 1305, 1308, 1309, 1310, 1311].includes(code ?? -1) || status === 429) {
      return 'rate_limited';
    }
    if (code === 1211) return 'model_not_found';
    if (code === 1234) return 'network_error';
    if ([1200, 1230].includes(code ?? -1) || status >= 500) return 'server_error';
    if (status === 408) return 'timeout';
    return 'validation_error';
  }

  private providerCode(value: unknown): number | undefined {
    try {
      const body = this.record(value);
      return typeof body.code === 'number' && Number.isInteger(body.code) ? body.code : undefined;
    } catch {
      return undefined;
    }
  }

  private validateBaseUrl(value: string): void {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Z.AI base URL is invalid');
    }
    if (
      value !== ZAI_GLOBAL_BASE_URL ||
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'api.z.ai' ||
      parsed.pathname !== '/api/paas/v4' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('Z.AI base URL must equal the canonical Z.AI global endpoint');
    }
  }

  private validateApiKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error('Z.AI bearer value must be non-empty');
    return trimmed;
  }

  private validateTimeout(value: number): number {
    if (this.invalidNumber(value, 1_000, MAX_TIMEOUT_MS, true)) {
      throw new Error('Z.AI timeout must be an integer from 1000 to 300000 ms');
    }
    return value;
  }

  private requireStrings(input: Record<string, unknown>, ...keys: string[]): void {
    for (const key of keys) {
      if (!this.nonEmptyString(input[key])) throw new Error(`Z.AI request requires ${key}`);
    }
  }

  private validatePublicUrl(value: string, label: string): void {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Z.AI ${label} is invalid`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`Z.AI ${label} must be an HTTP(S) URL without credentials`);
    }
  }

  private nonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

  private invalidNumber(value: unknown, min: number, max: number, integer = false): boolean {
    return (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    );
  }

  private record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  }

  private nonNegativeInteger(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  }

  private isSuccess(status: number): boolean {
    return status >= 200 && status < 300;
  }

  private successResponse(
    id: string,
    _request: ConnectorRequest,
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
        totalTokens: parsed.totalTokens,
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
