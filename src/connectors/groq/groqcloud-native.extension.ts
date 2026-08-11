const GROQCLOUD_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BATCH_FILE_BYTES = 100 * 1024 * 1024;

type StaticGroqCloudPath =
  | '/chat/completions'
  | '/responses'
  | '/audio/translations'
  | '/audio/speech'
  | '/batches'
  | '/files';

export type GroqCloudPath =
  | StaticGroqCloudPath
  | `/models/${string}`
  | `/batches/${string}`
  | `/batches/${string}/cancel`
  | `/files/${string}`
  | `/files/${string}/content`;

export interface GroqCloudTransportRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: GroqCloudPath;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  contentType?: 'application/json' | 'multipart/form-data';
  stream?: boolean;
  timeoutMs: number;
}

export interface GroqCloudTransportResponse {
  status: number;
  body: unknown;
}

export interface GroqCloudTransport {
  request(input: GroqCloudTransportRequest): Promise<GroqCloudTransportResponse>;
}

export interface GroqCloudConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface GroqCloudAudioFile {
  filename: string;
  contentType:
    | 'audio/flac'
    | 'audio/mpeg'
    | 'audio/mp4'
    | 'audio/m4a'
    | 'audio/ogg'
    | 'audio/wav'
    | 'audio/webm';
  data: Uint8Array;
}

export interface GroqCloudBatchFile {
  filename: string;
  contentType: 'application/jsonl';
  data: Uint8Array;
}

interface SafeProviderError {
  type: 'auth_error' | 'timeout' | 'rate_limited' | 'server_error' | 'validation_error';
  message: string;
}

export class GroqCloudNativeExtension {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(
    config: GroqCloudConfig,
    private readonly transport: GroqCloudTransport,
  ) {
    this.validateBaseUrl(config.baseUrl);
    this.apiKey = this.validateApiKey(config.apiKey);
    this.timeoutMs = this.validateTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  createResponse(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'model');
    if (!this.validResponseInput(input.input)) throw new Error('GroqCloud Responses requires input');
    return this.requestJson({
      method: 'POST',
      path: '/responses',
      body: { ...input, stream: false },
      contentType: 'application/json',
      stream: false,
      timeoutMs: this.timeoutMs,
    });
  }

  async *streamResponse(input: Record<string, unknown>): AsyncGenerator<string> {
    this.requireStrings(input, 'model');
    if (!this.validResponseInput(input.input)) throw new Error('GroqCloud Responses requires input');
    yield* this.streamOperation(
      {
        method: 'POST',
        path: '/responses',
        body: { ...input, stream: true },
        contentType: 'application/json',
        stream: true,
        timeoutMs: this.timeoutMs,
      },
      (event) => this.responseDelta(event),
      'response.completed',
    );
  }

  async *streamChat(input: Record<string, unknown>): AsyncGenerator<string> {
    this.requireStrings(input, 'model');
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new Error('GroqCloud chat requires messages');
    }
    yield* this.streamOperation(
      {
        method: 'POST',
        path: '/chat/completions',
        body: { ...input, stream: true },
        contentType: 'application/json',
        stream: true,
        timeoutMs: this.timeoutMs,
      },
      (event) => this.chatDelta(event),
      '[DONE]',
    );
  }

  translateAudio(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'model');
    if (!this.validAudioFile(input.file) && !this.validUrl(input.url)) {
      throw new Error('GroqCloud translation requires file or url');
    }
    return this.requestJson({
      method: 'POST',
      path: '/audio/translations',
      body: input,
      contentType: 'multipart/form-data',
      timeoutMs: this.timeoutMs,
    });
  }

  async createSpeech(input: Record<string, unknown>): Promise<Uint8Array> {
    this.requireStrings(input, 'model', 'input', 'voice');
    const response = await this.request({
      method: 'POST',
      path: '/audio/speech',
      body: input,
      contentType: 'application/json',
      timeoutMs: this.timeoutMs,
    });
    if (!(response.body instanceof Uint8Array)) {
      throw new Error('GroqCloud speech response was not binary');
    }
    return response.body;
  }

  retrieveModel(model: string): Promise<Record<string, unknown>> {
    const id = this.validateIdentifier(model, 'model');
    return this.requestJson({ method: 'GET', path: `/models/${id}`, timeoutMs: this.timeoutMs });
  }

  createBatch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireStrings(input, 'input_file_id', 'endpoint', 'completion_window');
    if (input.endpoint !== '/v1/chat/completions') {
      throw new Error('GroqCloud batch endpoint must be /v1/chat/completions');
    }
    if (!/^(24h|[2-7]d)$/.test(input.completion_window as string)) {
      throw new Error('GroqCloud batch completion_window must be 24h through 7d');
    }
    return this.requestJson({
      method: 'POST',
      path: '/batches',
      body: input,
      contentType: 'application/json',
      timeoutMs: this.timeoutMs,
    });
  }

  retrieveBatch(batchId: string): Promise<Record<string, unknown>> {
    const id = this.validateIdentifier(batchId, 'batch');
    return this.requestJson({ method: 'GET', path: `/batches/${id}`, timeoutMs: this.timeoutMs });
  }

  listBatches(): Promise<Record<string, unknown>> {
    return this.requestJson({ method: 'GET', path: '/batches', timeoutMs: this.timeoutMs });
  }

  cancelBatch(batchId: string): Promise<Record<string, unknown>> {
    const id = this.validateIdentifier(batchId, 'batch');
    return this.requestJson({
      method: 'POST',
      path: `/batches/${id}/cancel`,
      contentType: 'application/json',
      timeoutMs: this.timeoutMs,
    });
  }

  uploadFile(file: GroqCloudBatchFile): Promise<Record<string, unknown>> {
    if (
      file.contentType !== 'application/jsonl' ||
      !file.filename.toLowerCase().endsWith('.jsonl') ||
      file.data.byteLength === 0 ||
      file.data.byteLength > MAX_BATCH_FILE_BYTES
    ) {
      throw new Error('GroqCloud batch file must be a non-empty JSONL file up to 100 MB');
    }
    return this.requestJson({
      method: 'POST',
      path: '/files',
      body: { file, purpose: 'batch' },
      contentType: 'multipart/form-data',
      timeoutMs: this.timeoutMs,
    });
  }

  listFiles(): Promise<Record<string, unknown>> {
    return this.requestJson({ method: 'GET', path: '/files', timeoutMs: this.timeoutMs });
  }

  deleteFile(fileId: string): Promise<Record<string, unknown>> {
    const id = this.validateIdentifier(fileId, 'file');
    return this.requestJson({ method: 'DELETE', path: `/files/${id}`, timeoutMs: this.timeoutMs });
  }

  retrieveFile(fileId: string): Promise<Record<string, unknown>> {
    const id = this.validateIdentifier(fileId, 'file');
    return this.requestJson({ method: 'GET', path: `/files/${id}`, timeoutMs: this.timeoutMs });
  }

  async downloadFile(fileId: string): Promise<string | Uint8Array> {
    const id = this.validateIdentifier(fileId, 'file');
    const response = await this.request({
      method: 'GET',
      path: `/files/${id}/content`,
      timeoutMs: this.timeoutMs,
    });
    if (typeof response.body !== 'string' && !(response.body instanceof Uint8Array)) {
      throw new Error('GroqCloud file content response was malformed');
    }
    return response.body;
  }

  private async requestJson(
    input: Omit<GroqCloudTransportRequest, 'headers'>,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(input);
    return this.record(response.body, 'GroqCloud success response was malformed');
  }

  private async request(
    input: Omit<GroqCloudTransportRequest, 'headers'>,
  ): Promise<GroqCloudTransportResponse> {
    let response: GroqCloudTransportResponse;
    try {
      response = await this.transport.request({ ...input, headers: this.headers(input.contentType) });
    } catch {
      throw new Error('network_error: GroqCloud transport failed');
    }
    if (response.status < 200 || response.status >= 300) {
      const error = this.safeProviderError(response.status, response.body);
      throw new Error(`${error.type}: ${error.message}`);
    }
    return response;
  }

  private async *streamOperation(
    input: Omit<GroqCloudTransportRequest, 'headers'>,
    extractDelta: (event: unknown) => string | undefined,
    terminal: '[DONE]' | 'response.completed',
  ): AsyncGenerator<string> {
    const response = await this.request(input);
    yield* this.decodeSse(response.body, extractDelta, terminal);
  }

  private async *decodeSse(
    body: unknown,
    extractDelta: (event: unknown) => string | undefined,
    terminal: '[DONE]' | 'response.completed',
  ): AsyncGenerator<string> {
    let buffer = '';
    let done = false;
    for await (const chunk of this.streamChunks(body)) {
      buffer += chunk;
      let boundary = this.eventBoundary(buffer);
      while (boundary) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = this.parseSseEvent(event, extractDelta, terminal);
        if (done && parsed.event) {
          throw new Error(`GroqCloud SSE contains data after ${this.terminalLabel(terminal)}`);
        }
        if (parsed.done) done = true;
        if (parsed.delta !== undefined) yield parsed.delta;
        boundary = this.eventBoundary(buffer);
      }
    }
    if (buffer.trim()) {
      const parsed = this.parseSseEvent(buffer, extractDelta, terminal);
      if (done && parsed.event) {
        throw new Error(`GroqCloud SSE contains data after ${this.terminalLabel(terminal)}`);
      }
      if (parsed.done) done = true;
      if (parsed.delta !== undefined) yield parsed.delta;
    }
    if (!done) throw new Error(`GroqCloud SSE ended without ${terminal}`);
  }

  private terminalLabel(terminal: '[DONE]' | 'response.completed'): string {
    return terminal === '[DONE]' ? 'DONE' : terminal;
  }

  private parseSseEvent(
    event: string,
    extractDelta: (event: unknown) => string | undefined,
    terminal: '[DONE]' | 'response.completed',
  ): { event?: boolean; done?: boolean; delta?: string } {
    const lines = event.split(/\r?\n/).filter((line) => line && !line.startsWith(':'));
    if (lines.length === 0) return {};
    const data = lines
      .map((line) => {
        if (!line.startsWith('data:')) throw new Error('GroqCloud SSE must contain data-only events');
        return line.slice(5).replace(/^ /, '');
      })
      .join('\n');
    if (data === '[DONE]') {
      if (terminal !== '[DONE]') throw new Error('GroqCloud Responses SSE event type is unsupported');
      return { event: true, done: true };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      throw new Error('GroqCloud SSE data is not valid JSON');
    }
    if (terminal === 'response.completed') {
      const body = this.record(parsed, 'GroqCloud Responses SSE event was malformed');
      if (body.type === terminal) return { event: true, done: true };
    }
    const delta = extractDelta(parsed);
    return delta ? { event: true, delta } : { event: true };
  }

  private chatDelta(value: unknown): string | undefined {
    const body = this.record(value, 'GroqCloud chat SSE event was malformed');
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      throw new Error('GroqCloud chat SSE event is missing choices');
    }
    const choice = this.record(body.choices[0], 'GroqCloud chat SSE choice was malformed');
    const delta = this.record(choice.delta, 'GroqCloud chat SSE delta was malformed');
    if (delta.content === null || delta.content === undefined) return undefined;
    if (typeof delta.content !== 'string') throw new Error('GroqCloud chat SSE delta must be text');
    return delta.content;
  }

  private responseDelta(value: unknown): string | undefined {
    const body = this.record(value, 'GroqCloud Responses SSE event was malformed');
    if (body.type !== 'response.output_text.delta') {
      throw new Error('GroqCloud Responses SSE event type is unsupported');
    }
    if (typeof body.delta !== 'string') throw new Error('GroqCloud Responses SSE delta must be text');
    return body.delta;
  }

  private async *streamChunks(value: unknown): AsyncGenerator<string> {
    if (typeof value === 'string') {
      yield value;
      return;
    }
    if (!this.isAsyncIterable(value)) throw new Error('GroqCloud SSE body is not async iterable');
    const decoder = new TextDecoder();
    for await (const chunk of value) {
      if (typeof chunk === 'string') yield chunk;
      else if (chunk instanceof Uint8Array) yield decoder.decode(chunk, { stream: true });
      else throw new Error('GroqCloud SSE chunk must be text or bytes');
    }
    const tail = decoder.decode();
    if (tail) yield tail;
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

  private headers(contentType?: GroqCloudTransportRequest['contentType']): Readonly<Record<string, string>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (contentType === 'application/json') headers['Content-Type'] = 'application/json';
    return headers;
  }

  private safeProviderError(status: number, value: unknown): SafeProviderError {
    const code = this.providerCode(value);
    const suffix = code ? `, code ${code}` : '';
    return {
      type:
        status === 401 || status === 403
          ? 'auth_error'
          : status === 408
            ? 'timeout'
            : status === 429
              ? 'rate_limited'
              : status >= 500
                ? 'server_error'
                : 'validation_error',
      message: `GroqCloud request failed (HTTP ${status}${suffix})`,
    };
  }

  private providerCode(value: unknown): string | undefined {
    try {
      const outer = this.record(value, '');
      const error = this.record(outer.error, '');
      return typeof error.code === 'string' && /^[A-Za-z0-9._-]+$/.test(error.code)
        ? error.code
        : undefined;
    } catch {
      return undefined;
    }
  }

  private validateBaseUrl(value: string): void {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('GroqCloud base URL is invalid');
    }
    if (
      value !== GROQCLOUD_BASE_URL ||
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'api.groq.com' ||
      parsed.pathname !== '/openai/v1' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('GroqCloud base URL must equal the canonical GroqCloud endpoint');
    }
  }

  private validateApiKey(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('GroqCloud bearer value must be non-empty');
    return trimmed;
  }

  private validateTimeout(value: number): number {
    if (!Number.isInteger(value) || value < 1_000 || value > MAX_TIMEOUT_MS) {
      throw new Error('GroqCloud timeout must be an integer from 1000 to 300000 ms');
    }
    return value;
  }

  private validateIdentifier(value: string, label: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`GroqCloud ${label} identifier is invalid`);
    return value;
  }

  private requireStrings(input: Record<string, unknown>, ...keys: string[]): void {
    for (const key of keys) {
      if (typeof input[key] !== 'string' || (input[key] as string).trim().length === 0) {
        throw new Error(`GroqCloud request requires ${key}`);
      }
    }
  }

  private validResponseInput(value: unknown): boolean {
    return (typeof value === 'string' && value.trim().length > 0) || (Array.isArray(value) && value.length > 0);
  }

  private validAudioFile(value: unknown): value is GroqCloudAudioFile {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const file = value as Partial<GroqCloudAudioFile>;
    const allowedTypes = new Set([
      'audio/flac',
      'audio/mpeg',
      'audio/mp4',
      'audio/m4a',
      'audio/ogg',
      'audio/wav',
      'audio/webm',
    ]);
    return (
      typeof file.filename === 'string' &&
      file.filename.trim().length > 0 &&
      typeof file.contentType === 'string' &&
      allowedTypes.has(file.contentType) &&
      file.data instanceof Uint8Array &&
      file.data.byteLength > 0
    );
  }

  private validUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  private record(value: unknown, message: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
    return value as Record<string, unknown>;
  }
}
