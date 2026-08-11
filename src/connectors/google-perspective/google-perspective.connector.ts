import {
  buildAnalyzeBody,
  parseAnalyzeResponse,
  PerspectiveValidationFailure,
  assertSafeValue,
  asRecord,
} from './validation';
import type {
  AnalyzeCommentInput,
  AnalyzeCommentResult,
  GooglePerspectiveConnectorOptions,
  GooglePerspectiveErrorCategory,
  PerspectiveTransport,
  PerspectiveTransportRequest,
  PerspectiveTransportResponse,
} from './types';

const ORIGIN = 'https://commentanalyzer.googleapis.com';
const ANALYZE_PATH = '/v1alpha1/comments:analyze';
const RETIRED_AT_MS = Date.parse('2027-01-01T00:00:00.000Z');
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_API_KEY_LENGTH = 4_096;
const MAX_REQUEST_BYTES = 131_072;
const MAX_RESPONSE_BYTES = 262_144;

interface ErrorFields {
  httpStatus?: number;
  providerCode?: number;
  providerStatus?: string;
}

export class GooglePerspectiveError extends Error {
  readonly category: GooglePerspectiveErrorCategory;
  readonly httpStatus?: number;
  readonly providerCode?: number;
  readonly providerStatus?: string;

  constructor(category: GooglePerspectiveErrorCategory, fields: ErrorFields = {}) {
    super(`Google Perspective ${category} failure`);
    this.name = 'GooglePerspectiveError';
    this.category = category;
    if (fields.httpStatus !== undefined) this.httpStatus = fields.httpStatus;
    if (fields.providerCode !== undefined) this.providerCode = fields.providerCode;
    if (fields.providerStatus !== undefined) this.providerStatus = fields.providerStatus;
  }
}

export class GooglePerspectiveTransportTimeoutError extends Error {
  constructor(message = 'transport timeout') {
    super(message);
    this.name = 'GooglePerspectiveTransportTimeoutError';
  }
}

const validationError = (): GooglePerspectiveError => new GooglePerspectiveError('validation');
const responseError = (): GooglePerspectiveError => new GooglePerspectiveError('response');

const validateTransportResponse = (value: unknown): PerspectiveTransportResponse => {
  assertSafeValue(value);
  const record = asRecord(value);
  const keys = Object.keys(record);
  if (
    keys.some((key) => !['status', 'contentType', 'bodyBytes', 'body'].includes(key)) ||
    !Object.prototype.hasOwnProperty.call(record, 'status') ||
    !Object.prototype.hasOwnProperty.call(record, 'contentType') ||
    !Object.prototype.hasOwnProperty.call(record, 'bodyBytes') ||
    !Object.prototype.hasOwnProperty.call(record, 'body') ||
    !Number.isInteger(record.status) ||
    (record.status as number) < 100 ||
    (record.status as number) > 599 ||
    typeof record.contentType !== 'string' ||
    !Number.isInteger(record.bodyBytes) ||
    (record.bodyBytes as number) < 0 ||
    (record.bodyBytes as number) > MAX_RESPONSE_BYTES
  ) {
    throw responseError();
  }
  return record as unknown as PerspectiveTransportResponse;
};

const parseProviderFailure = (status: number, body: unknown): GooglePerspectiveError => {
  const fields: ErrorFields = { httpStatus: status };
  try {
    assertSafeValue(body);
    const envelope = asRecord(body);
    const errorValue = envelope.error;
    const error = asRecord(errorValue);
    if (typeof error.code === 'number' && Number.isInteger(error.code)) fields.providerCode = error.code;
    if (
      typeof error.status === 'string' &&
      error.status.length <= 128 &&
      /^[A-Z][A-Z0-9_]*$/.test(error.status)
    ) {
      fields.providerStatus = error.status;
    }
  } catch {
    // Provider bodies are untrusted. A malformed body adds no public fields.
  }
  return new GooglePerspectiveError('provider', fields);
};

export class GooglePerspectiveConnector {
  private readonly apiKey: string;
  private readonly transport: PerspectiveTransport;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly allowProviderStorage: boolean;

  constructor(options: GooglePerspectiveConnectorOptions) {
    try {
      if (options === null || typeof options !== 'object' || Array.isArray(options)) throw validationError();
      const { apiKey, transport, now } = options;
      if (
        typeof apiKey !== 'string' ||
        apiKey.length === 0 ||
        apiKey.length > MAX_API_KEY_LENGTH ||
        typeof transport !== 'function' ||
        typeof now !== 'function'
      ) {
        throw validationError();
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        throw validationError();
      }
      if (
        options.allowProviderStorage !== undefined &&
        typeof options.allowProviderStorage !== 'boolean'
      ) {
        throw validationError();
      }
      this.apiKey = apiKey;
      this.transport = transport;
      this.now = now;
      this.timeoutMs = timeoutMs;
      this.allowProviderStorage = options.allowProviderStorage ?? false;
    } catch (error) {
      if (error instanceof GooglePerspectiveError) throw error;
      throw validationError();
    }
  }

  async analyze(input: AnalyzeCommentInput): Promise<AnalyzeCommentResult> {
    let instant: Date;
    try {
      instant = this.now();
    } catch {
      throw new GooglePerspectiveError('lifecycle');
    }
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime()) || instant.getTime() >= RETIRED_AT_MS) {
      throw new GooglePerspectiveError('lifecycle');
    }

    let bodyRecord: Record<string, unknown>;
    let body: string;
    try {
      bodyRecord = buildAnalyzeBody(input, this.allowProviderStorage);
      body = JSON.stringify(bodyRecord);
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw validationError();
    } catch (error) {
      if (error instanceof GooglePerspectiveError) throw error;
      if (error instanceof PerspectiveValidationFailure) throw validationError();
      throw validationError();
    }

    const url = new URL(ANALYZE_PATH, ORIGIN);
    url.searchParams.set('key', this.apiKey);
    const headers = Object.freeze({ 'Content-Type': 'application/json' });
    const request: Readonly<PerspectiveTransportRequest> = Object.freeze({
      url: url.toString(),
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      timeoutMs: this.timeoutMs,
    });

    let rawResponse: unknown;
    try {
      rawResponse = await this.transport(request);
    } catch (error) {
      if (error instanceof GooglePerspectiveTransportTimeoutError) {
        throw new GooglePerspectiveError('timeout');
      }
      throw new GooglePerspectiveError('transport');
    }

    let providerResponse: PerspectiveTransportResponse;
    try {
      providerResponse = validateTransportResponse(rawResponse);
    } catch (error) {
      if (error instanceof GooglePerspectiveError) throw error;
      throw responseError();
    }

    if (providerResponse.status >= 300) {
      return Promise.reject(parseProviderFailure(providerResponse.status, providerResponse.body));
    }
    if (
      providerResponse.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(providerResponse.contentType)
    ) {
      throw responseError();
    }

    try {
      const comment = asRecord(bodyRecord.comment);
      return parseAnalyzeResponse(providerResponse.body, String(comment.text).length);
    } catch (error) {
      if (error instanceof GooglePerspectiveError) throw error;
      throw responseError();
    }
  }
}
