import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

interface OpenAiResponse {
  id?: string;
  status?: string;
  model?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
}

export const OPENAI_MODERATION_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
] as const;

export type OpenAiModerationCategory = (typeof OPENAI_MODERATION_CATEGORIES)[number];
export type OpenAiModerationInputType = 'text' | 'image';

export type OpenAiModerationInput =
  | string
  | string[]
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface OpenAiModerationRequest {
  input: OpenAiModerationInput;
  model?: string;
  timeout?: number;
}

export interface OpenAiModerationNormalizedResult {
  flagged: boolean;
  categories: Readonly<Record<OpenAiModerationCategory, boolean>>;
  categoryScores: Readonly<Record<OpenAiModerationCategory, number>>;
  categoryAppliedInputTypes: Readonly<
    Record<OpenAiModerationCategory, readonly OpenAiModerationInputType[]>
  >;
}

export type OpenAiModerationErrorType =
  | 'validation_error'
  | 'auth_error'
  | 'rate_limited'
  | 'server_error'
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'malformed_response';

export interface OpenAiModerationOperationError {
  type: OpenAiModerationErrorType;
  message: string;
  retryable: boolean;
  httpStatus?: number;
}

export type OpenAiModerationOperationResult =
  | {
      status: 'success';
      id: string;
      model: string;
      results: readonly OpenAiModerationNormalizedResult[];
    }
  | {
      status: 'error' | 'timeout' | 'rate_limited';
      model: string;
      results: readonly [];
      error: OpenAiModerationOperationError;
    };

const DEFAULT_MODEL = 'gpt-4.1-mini';
const STATIC_MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4.1-nano'];
const MODERATIONS_ENDPOINT = 'https://api.openai.com/v1/moderations';
const DEFAULT_MODERATION_MODEL = 'omni-moderation-latest';
const ALLOWED_MODERATION_MODELS = new Set([DEFAULT_MODERATION_MODEL, 'omni-moderation-2024-09-26']);
const MAX_MODERATION_INPUTS = 2_048;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_REMOTE_URL_CHARS = 8_192;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;
const MAX_ID_CHARS = 256;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const REDACTION_MARKER = '[REDACTED]';

interface ParsedModerationEnvelope {
  id: string;
  model: string;
  results: readonly OpenAiModerationNormalizedResult[];
}

type ModerationRequestValidation =
  | { valid: true; body: Record<string, unknown>; timeout: number }
  | { valid: false; message: string };

/** Native OpenAI Responses connector with the explicit AU-031 Moderations extension. */
export class OpenAiConnector extends BaseApiConnector {
  readonly name = 'openai';

  /**
   * Execute the first-party Moderations operation without widening the generic
   * generation-shaped ConnectorRequest contract.
   */
  async moderate(request: OpenAiModerationRequest): Promise<OpenAiModerationOperationResult> {
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const requestedModel = this.safeModel(request, apiKey);

    if (apiKey.length === 0) {
      return this.moderationError(
        'auth_error',
        requestedModel,
        'OpenAI Moderations requires OPENAI_API_KEY',
        apiKey,
      );
    }

    let validation: ModerationRequestValidation;
    try {
      validation = this.validateModerationRequest(request);
    } catch {
      return this.moderationError(
        'validation_error',
        requestedModel,
        'OpenAI Moderations request could not be validated safely',
        apiKey,
      );
    }
    if (!validation.valid) {
      return this.moderationError('validation_error', requestedModel, validation.message, apiKey);
    }

    try {
      const response = await fetch(MODERATIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(validation.body),
        signal: AbortSignal.timeout(validation.timeout),
      });
      const bounded = await this.readBoundedBody(response);
      if (!bounded.complete) {
        return this.moderationError(
          'malformed_response',
          requestedModel,
          'OpenAI Moderations response exceeded the safe byte limit',
          apiKey,
        );
      }
      if (!response.ok) {
        const errorType = this.classifyModerationHttpError(response.status);
        const message = bounded.text.length > 0 ? bounded.text : 'OpenAI Moderations HTTP error';
        return this.moderationError(errorType, requestedModel, message, apiKey, response.status);
      }

      const parsed = this.parseModerationEnvelope(
        bounded.text,
        this.expectedModerationResultCount(request.input),
        apiKey,
      );
      if (parsed === null) {
        return this.moderationError(
          'malformed_response',
          requestedModel,
          'OpenAI Moderations returned an invalid response envelope',
          apiKey,
        );
      }
      return {
        status: 'success',
        id: parsed.id,
        model: parsed.model,
        results: parsed.results,
      };
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      return this.moderationError(
        aborted ? 'timeout' : 'network_error',
        requestedModel,
        this.safeThrownMessage(error, aborted),
        apiKey,
      );
    }
  }

  protected getBaseUrl(): string {
    return process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  }

  protected getStaticModels(): string[] {
    return STATIC_MODELS;
  }

  protected getTimeout(): number {
    return Number(process.env.OPENAI_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
    };
  }

  protected getHealthProbePath(): string {
    return '/v1/models';
  }

  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/v1/models`;
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/v1/responses`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') {
      throw new Error('openai connector requires a string prompt');
    }
    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      input: request.prompt,
    };
    if (request.systemPrompt) body.instructions = request.systemPrompt;
    if (request.effort) body.reasoning = { effort: request.effort };
    if (request.jsonSchema) {
      body.text = {
        format: {
          type: 'json_schema',
          name: 'response',
          strict: true,
          schema: request.jsonSchema,
        },
      };
    } else if (request.responseFormat?.type === 'json_object') {
      body.text = { format: { type: 'json_object' } };
    }
    for (const key of ['max_output_tokens', 'temperature', 'top_p'] as const) {
      if (request.extra?.[key] != null) body[key] = request.extra[key];
    }
    return body;
  }

  protected parseResponse(json: OpenAiResponse, request: ConnectorRequest): ParsedApiOutput {
    const text = (json.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const completed = json.status === 'completed';
    const reason = json.error?.message ?? json.incomplete_details?.reason;
    return {
      text,
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      costUsd: 0,
      isError: !completed,
      errorMessage: completed
        ? undefined
        : `OpenAI response ${json.status ?? 'failed'}${reason ? `: ${reason}` : ''}`,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map((model) => model.id),
      modelMeta,
      modality: 'chat',
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }

  private validateModerationRequest(request: OpenAiModerationRequest): ModerationRequestValidation {
    if (
      !this.isPlainObject(request) ||
      !this.hasExactKeys(request, ['input', 'model', 'timeout'])
    ) {
      return { valid: false, message: 'OpenAI Moderations request has unknown fields' };
    }
    if (!this.isValidModerationInput(request.input)) {
      return { valid: false, message: 'OpenAI Moderations input has an invalid or empty shape' };
    }
    if (request.model !== undefined && !ALLOWED_MODERATION_MODELS.has(request.model)) {
      return { valid: false, message: 'OpenAI Moderations model is not allowlisted' };
    }
    const timeout = request.timeout ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
      return { valid: false, message: 'OpenAI Moderations timeout is outside the safe range' };
    }

    const body: Record<string, unknown> = { input: request.input };
    if (request.model !== undefined) body.model = request.model;
    return { valid: true, body, timeout };
  }

  private isValidModerationInput(input: unknown): input is OpenAiModerationInput {
    if (typeof input === 'string') return this.isValidText(input);
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MODERATION_INPUTS) {
      return false;
    }
    if (input.every((item) => typeof item === 'string')) {
      return input.every((item) => this.isValidText(item));
    }
    if (!input.every((item) => this.isPlainObject(item))) return false;
    return input.every((item) => this.isValidModerationContentPart(item));
  }

  private isValidModerationContentPart(value: Record<string, unknown>): boolean {
    if (value.type === 'text') {
      return this.hasExactKeys(value, ['type', 'text']) && this.isValidText(value.text);
    }
    if (value.type !== 'image_url' || !this.hasExactKeys(value, ['type', 'image_url'])) {
      return false;
    }
    const imageUrl = value.image_url;
    return (
      this.isPlainObject(imageUrl) &&
      this.hasExactKeys(imageUrl, ['url']) &&
      this.isValidImageUrl(imageUrl.url)
    );
  }

  private isValidText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_CHARS;
  }

  private isValidImageUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (value.startsWith('data:')) return this.isValidImageDataUrl(value);
    if (value.length > MAX_REMOTE_URL_CHARS) return false;
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === 'https:' &&
        parsed.hostname.length > 0 &&
        parsed.username.length === 0 &&
        parsed.password.length === 0
      );
    } catch {
      return false;
    }
  }

  private isValidImageDataUrl(value: string): boolean {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
    if (match === null) return false;
    const encoded = match[1];
    if (encoded.length === 0 || encoded.length > MAX_BASE64_CHARS || encoded.length % 4 !== 0) {
      return false;
    }
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    return (encoded.length / 4) * 3 - padding <= MAX_IMAGE_BYTES;
  }

  private expectedModerationResultCount(input: OpenAiModerationInput): number {
    return Array.isArray(input) && input.every((item) => typeof item === 'string')
      ? input.length
      : 1;
  }

  private async readBoundedBody(
    response: Response,
  ): Promise<{ complete: true; text: string } | { complete: false; text: '' }> {
    if (response.body === null) return { complete: true, text: '' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return { complete: false, text: '' };
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { complete: true, text: new TextDecoder().decode(combined) };
  }

  private parseModerationEnvelope(
    text: string,
    expectedResultCount: number,
    apiKey: string,
  ): ParsedModerationEnvelope | null {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
    if (!this.isPlainObject(value) || !this.hasExactKeys(value, ['id', 'model', 'results'])) {
      return null;
    }
    if (
      typeof value.id !== 'string' ||
      value.id.length === 0 ||
      value.id.length > MAX_ID_CHARS ||
      typeof value.model !== 'string' ||
      !ALLOWED_MODERATION_MODELS.has(value.model) ||
      !Array.isArray(value.results) ||
      value.results.length !== expectedResultCount ||
      value.results.length > MAX_MODERATION_INPUTS
    ) {
      return null;
    }

    const results: OpenAiModerationNormalizedResult[] = [];
    for (const result of value.results) {
      const normalized = this.parseModerationResult(result);
      if (normalized === null) return null;
      results.push(normalized);
    }
    return Object.freeze({
      id: this.redact(value.id, apiKey),
      model: value.model,
      results: Object.freeze(results),
    });
  }

  private parseModerationResult(value: unknown): OpenAiModerationNormalizedResult | null {
    if (
      !this.isPlainObject(value) ||
      !this.hasExactKeys(value, [
        'flagged',
        'categories',
        'category_scores',
        'category_applied_input_types',
      ]) ||
      typeof value.flagged !== 'boolean'
    ) {
      return null;
    }
    const categories = this.parseCategoryBooleans(value.categories);
    const scores = this.parseCategoryScores(value.category_scores);
    const appliedTypes = this.parseCategoryAppliedTypes(value.category_applied_input_types);
    if (categories === null || scores === null || appliedTypes === null) return null;

    const flagged = OPENAI_MODERATION_CATEGORIES.some((category) => categories[category]);
    if (flagged !== value.flagged) return null;
    return Object.freeze({
      flagged,
      categories: Object.freeze(categories),
      categoryScores: Object.freeze(scores),
      categoryAppliedInputTypes: Object.freeze(appliedTypes),
    });
  }

  private parseCategoryBooleans(value: unknown): Record<OpenAiModerationCategory, boolean> | null {
    if (!this.hasExactCategoryKeys(value)) return null;
    const output = {} as Record<OpenAiModerationCategory, boolean>;
    for (const category of OPENAI_MODERATION_CATEGORIES) {
      const flag = value[category];
      if (typeof flag !== 'boolean') return null;
      output[category] = flag;
    }
    return output;
  }

  private parseCategoryScores(value: unknown): Record<OpenAiModerationCategory, number> | null {
    if (!this.hasExactCategoryKeys(value)) return null;
    const output = {} as Record<OpenAiModerationCategory, number>;
    for (const category of OPENAI_MODERATION_CATEGORIES) {
      const score = value[category];
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
        return null;
      }
      output[category] = score;
    }
    return output;
  }

  private parseCategoryAppliedTypes(
    value: unknown,
  ): Record<OpenAiModerationCategory, readonly OpenAiModerationInputType[]> | null {
    if (!this.hasExactCategoryKeys(value)) return null;
    const output = {} as Record<OpenAiModerationCategory, readonly OpenAiModerationInputType[]>;
    for (const category of OPENAI_MODERATION_CATEGORIES) {
      const types = value[category];
      if (
        !Array.isArray(types) ||
        types.length > 2 ||
        !types.every((type) => type === 'text' || type === 'image') ||
        new Set(types).size !== types.length
      ) {
        return null;
      }
      output[category] = Object.freeze([...types]) as readonly OpenAiModerationInputType[];
    }
    return output;
  }

  private hasExactCategoryKeys(value: unknown): value is Record<OpenAiModerationCategory, unknown> {
    return (
      this.isPlainObject(value) &&
      Object.keys(value).length === OPENAI_MODERATION_CATEGORIES.length &&
      this.hasExactKeys(value, OPENAI_MODERATION_CATEGORIES)
    );
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  }

  private hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const present = Object.keys(value);
    return (
      present.every((key) => allowed.includes(key)) &&
      present.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(value, key) &&
          Object.prototype.hasOwnProperty.call(
            Object.getOwnPropertyDescriptor(value, key) ?? {},
            'value',
          ),
      )
    );
  }

  private classifyModerationHttpError(status: number): OpenAiModerationErrorType {
    if (status === 400 || status === 422) return 'validation_error';
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'http_error';
  }

  private moderationError(
    type: OpenAiModerationErrorType,
    model: string,
    message: string,
    apiKey: string,
    httpStatus?: number,
  ): OpenAiModerationOperationResult {
    const status =
      type === 'timeout' ? 'timeout' : type === 'rate_limited' ? 'rate_limited' : 'error';
    const retryable =
      type === 'timeout' ||
      type === 'network_error' ||
      type === 'rate_limited' ||
      type === 'server_error';
    return {
      status,
      model: this.redact(model, apiKey),
      results: [],
      error: {
        type,
        message: this.redact(message.slice(0, MAX_ERROR_CHARS), apiKey),
        retryable,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      },
    };
  }

  private safeModel(request: OpenAiModerationRequest, apiKey: string): string {
    try {
      return this.redact(
        typeof request?.model === 'string' ? request.model : DEFAULT_MODERATION_MODEL,
        apiKey,
      );
    } catch {
      return DEFAULT_MODERATION_MODEL;
    }
  }

  private safeThrownMessage(error: unknown, aborted: boolean): string {
    const fallback = aborted
      ? 'OpenAI Moderations request timed out'
      : 'OpenAI Moderations transport failed';
    if (!(error instanceof Error)) return fallback;
    try {
      return typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : fallback;
    } catch {
      return fallback;
    }
  }

  private redact(value: string, apiKey: string): string {
    return apiKey.length === 0 ? value : value.split(apiKey).join(REDACTION_MARKER);
  }
}
