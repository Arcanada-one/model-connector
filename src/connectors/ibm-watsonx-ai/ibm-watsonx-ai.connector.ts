export const IBM_WATSONX_AI_API_VERSION = '2024-03-14' as const;

export const IBM_WATSONX_AI_BASE_URLS = Object.freeze([
  'https://us-south.ml.cloud.ibm.com',
  'https://eu-de.ml.cloud.ibm.com',
  'https://eu-gb.ml.cloud.ibm.com',
  'https://jp-tok.ml.cloud.ibm.com',
  'https://au-syd.ml.cloud.ibm.com',
  'https://ca-tor.ml.cloud.ibm.com',
  'https://ap-south-1.aws.wxai.ibm.com',
] as const);

export const IBM_WATSONX_AI_LIMITS = Object.freeze({
  modelIdBytes: 256,
  inputBytes: 32_768,
  bearerTokenBytes: 8_192,
  timeoutMs: 120_000,
  jsonDepth: 8,
  recordKeys: 16,
  arrayItems: 16,
  visitedNodes: 128,
  responseStringBytes: 65_536,
  imageBytes: 10 * 1024 * 1024,
  textResults: 8,
});

const TEXT_PATH = '/ml/v1/text/generation';
const IMAGE_PATH = '/ml/v1/text/image';
const UUID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MEDIA_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const STOP_REASONS = new Set([
  'not_finished',
  'max_tokens',
  'eos_token',
  'cancelled',
  'time_limit',
  'stop_sequence',
  'token_limit',
  'error',
]);

export type IbmWatsonxAiErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'invalid_response'
  | 'provider_error'
  | 'unexpected_response'
  | 'transport_error'
  | 'timeout';

const ERROR_MESSAGES: Readonly<Record<IbmWatsonxAiErrorCode, string>> = Object.freeze({
  invalid_configuration: 'IBM watsonx.ai configuration is invalid',
  invalid_request: 'IBM watsonx.ai request is invalid',
  invalid_response: 'IBM watsonx.ai response is invalid',
  provider_error: 'IBM watsonx.ai rejected the request',
  unexpected_response: 'IBM watsonx.ai returned an unexpected status',
  transport_error: 'IBM watsonx.ai transport failed',
  timeout: 'IBM watsonx.ai request timed out',
});

export class IbmWatsonxAiError extends Error {
  readonly code: IbmWatsonxAiErrorCode;
  readonly status?: number;

  constructor(code: IbmWatsonxAiErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = 'IbmWatsonxAiError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface IbmWatsonxAiTransportRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface IbmWatsonxAiTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type IbmWatsonxAiTransport = (
  request: Readonly<IbmWatsonxAiTransportRequest>,
) => Promise<IbmWatsonxAiTransportResponse>;

export interface IbmWatsonxAiConfiguration {
  readonly baseUrl: (typeof IBM_WATSONX_AI_BASE_URLS)[number];
  readonly apiVersion: typeof IBM_WATSONX_AI_API_VERSION;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  readonly transport: IbmWatsonxAiTransport;
}

export type IbmWatsonxAiScope =
  | Readonly<{ projectId: string }>
  | Readonly<{ spaceId: string }>;

export interface IbmWatsonxAiOperationRequest {
  readonly modelId: string;
  readonly input: string;
  readonly scope: IbmWatsonxAiScope;
}

export interface IbmWatsonxAiTextResult {
  readonly generatedText: string;
  readonly stopReason: string;
  readonly generatedTokenCount?: number;
  readonly inputTokenCount?: number;
}

export interface IbmWatsonxAiTextResponse {
  readonly modelId: string;
  readonly createdAt: string;
  readonly results: readonly IbmWatsonxAiTextResult[];
}

export interface IbmWatsonxAiConnector {
  generateText(request: IbmWatsonxAiOperationRequest): Promise<IbmWatsonxAiTextResponse>;
  generateImage(request: IbmWatsonxAiOperationRequest): Promise<Uint8Array>;
}

type ValidationCode = 'invalid_configuration' | 'invalid_request' | 'invalid_response';

function fail(code: ValidationCode): never {
  throw new IbmWatsonxAiError(code);
}

function normalizeValidation<T>(code: ValidationCode, validate: () => T): T {
  try {
    return validate();
  } catch (error: unknown) {
    if (error instanceof IbmWatsonxAiError && error.code === code) throw error;
    throw new IbmWatsonxAiError(code);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readDataRecord(value: unknown, code: ValidationCode): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) fail(code);
  if (ownKeys.length > IBM_WATSONX_AI_LIMITS.recordKeys) fail(code);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys as string[]) {
    if (DANGEROUS_KEYS.has(key)) fail(code);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      fail(code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: ValidationCode,
): Record<string, unknown> {
  const record = readDataRecord(value, code);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key))) fail(code);
  if (required.some((key) => !Object.hasOwn(record, key))) fail(code);
  return record;
}

function boundedString(
  value: unknown,
  maximumBytes: number,
  code: ValidationCode,
): string {
  if (typeof value !== 'string' || value.length === 0 || utf8Bytes(value) > maximumBytes) {
    fail(code);
  }
  return value;
}

function assertSafeData(value: unknown, code: ValidationCode): void {
  const ancestors = new WeakSet<object>();
  let visited = 0;

  const visit = (current: unknown, depth: number): void => {
    visited += 1;
    if (visited > IBM_WATSONX_AI_LIMITS.visitedNodes) fail(code);
    if (depth > IBM_WATSONX_AI_LIMITS.jsonDepth) fail(code);
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(code);
      return;
    }
    if (typeof current === 'string') {
      if (utf8Bytes(current) > IBM_WATSONX_AI_LIMITS.responseStringBytes) fail(code);
      return;
    }
    if (typeof current !== 'object') fail(code);
    if (ancestors.has(current)) fail(code);
    ancestors.add(current);
    if (Array.isArray(current)) {
      if (current.length > IBM_WATSONX_AI_LIMITS.arrayItems) fail(code);
      for (const item of current) visit(item, depth + 1);
    } else {
      const record = readDataRecord(current, code);
      for (const item of Object.values(record)) visit(item, depth + 1);
    }
    ancestors.delete(current);
  };

  visit(value, 0);
}

function validateConfiguration(value: unknown): Readonly<IbmWatsonxAiConfiguration> {
  const record = exactRecord(
    value,
    ['baseUrl', 'apiVersion', 'bearerToken', 'timeoutMs', 'transport'],
    [],
    'invalid_configuration',
  );
  if (
    typeof record.baseUrl !== 'string' ||
    !IBM_WATSONX_AI_BASE_URLS.includes(
      record.baseUrl as (typeof IBM_WATSONX_AI_BASE_URLS)[number],
    )
  ) {
    fail('invalid_configuration');
  }
  if (record.apiVersion !== IBM_WATSONX_AI_API_VERSION) fail('invalid_configuration');
  const bearerToken = boundedString(
    record.bearerToken,
    IBM_WATSONX_AI_LIMITS.bearerTokenBytes,
    'invalid_configuration',
  );
  if (
    typeof record.timeoutMs !== 'number' ||
    !Number.isInteger(record.timeoutMs) ||
    record.timeoutMs < 1 ||
    record.timeoutMs > IBM_WATSONX_AI_LIMITS.timeoutMs
  ) {
    fail('invalid_configuration');
  }
  if (typeof record.transport !== 'function') fail('invalid_configuration');
  return Object.freeze({
    baseUrl: record.baseUrl as (typeof IBM_WATSONX_AI_BASE_URLS)[number],
    apiVersion: IBM_WATSONX_AI_API_VERSION,
    bearerToken,
    timeoutMs: record.timeoutMs,
    transport: record.transport as IbmWatsonxAiTransport,
  });
}

function validateOperationRequest(value: unknown): Readonly<IbmWatsonxAiOperationRequest> {
  assertSafeData(value, 'invalid_request');
  const record = exactRecord(value, ['modelId', 'input', 'scope'], [], 'invalid_request');
  const modelId = boundedString(
    record.modelId,
    IBM_WATSONX_AI_LIMITS.modelIdBytes,
    'invalid_request',
  );
  const input = boundedString(
    record.input,
    IBM_WATSONX_AI_LIMITS.inputBytes,
    'invalid_request',
  );
  const scopeRecord = readDataRecord(record.scope, 'invalid_request');
  const scopeKeys = Object.keys(scopeRecord);
  if (scopeKeys.length !== 1) fail('invalid_request');
  if (Object.hasOwn(scopeRecord, 'projectId')) {
    if (scopeKeys[0] !== 'projectId') fail('invalid_request');
    const projectId = scopeRecord.projectId;
    if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId)) fail('invalid_request');
    return Object.freeze({
      modelId,
      input,
      scope: Object.freeze({ projectId }),
    });
  }
  if (Object.hasOwn(scopeRecord, 'spaceId')) {
    if (scopeKeys[0] !== 'spaceId') fail('invalid_request');
    const spaceId = scopeRecord.spaceId;
    if (typeof spaceId !== 'string' || !UUID_PATTERN.test(spaceId)) fail('invalid_request');
    return Object.freeze({
      modelId,
      input,
      scope: Object.freeze({ spaceId }),
    });
  }
  fail('invalid_request');
}

function createBody(request: Readonly<IbmWatsonxAiOperationRequest>): Readonly<Record<string, string>> {
  const scope = request.scope;
  if (Object.hasOwn(scope, 'projectId')) {
    return Object.freeze({
      model_id: request.modelId,
      input: request.input,
      project_id: (scope as Readonly<{ projectId: string }>).projectId,
    });
  }
  return Object.freeze({
    model_id: request.modelId,
    input: request.input,
    space_id: (scope as Readonly<{ spaceId: string }>).spaceId,
  });
}

function validMediaType(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || value.length > 256) return false;
  const segments = value.split(';').map((segment) => segment.trim());
  if (segments[0]?.toLowerCase() !== expected) return false;
  for (const parameter of segments.slice(1)) {
    const equals = parameter.indexOf('=');
    if (equals < 1) return false;
    const name = parameter.slice(0, equals);
    const content = parameter.slice(equals + 1);
    if (!MEDIA_TOKEN.test(name) || !MEDIA_TOKEN.test(content)) return false;
  }
  return true;
}

function validateTransportEnvelope(value: unknown): {
  status: number;
  contentType: string;
  body: unknown;
} {
  const record = exactRecord(value, ['status', 'headers', 'body'], [], 'invalid_response');
  if (
    typeof record.status !== 'number' ||
    !Number.isInteger(record.status) ||
    record.status < 100 ||
    record.status > 599
  ) {
    fail('invalid_response');
  }
  const headers = exactRecord(record.headers, ['content-type'], [], 'invalid_response');
  if (typeof headers['content-type'] !== 'string') fail('invalid_response');
  return {
    status: record.status,
    contentType: headers['content-type'],
    body: record.body,
  };
}

function validateProviderError(body: unknown): void {
  assertSafeData(body, 'invalid_response');
  const record = exactRecord(body, ['trace', 'errors'], ['status_code'], 'invalid_response');
  boundedString(record.trace, 256, 'invalid_response');
  if (!Array.isArray(record.errors) || record.errors.length < 1) fail('invalid_response');
  for (const item of record.errors) {
    const error = exactRecord(
      item,
      ['code', 'message'],
      ['more_info', 'target'],
      'invalid_response',
    );
    boundedString(error.code, 256, 'invalid_response');
    boundedString(error.message, IBM_WATSONX_AI_LIMITS.responseStringBytes, 'invalid_response');
    if (Object.hasOwn(error, 'more_info')) {
      boundedString(error.more_info, 2_048, 'invalid_response');
    }
    if (Object.hasOwn(error, 'target')) {
      const target = exactRecord(error.target, ['type', 'name'], [], 'invalid_response');
      if (!['field', 'parameter', 'header'].includes(String(target.type))) {
        fail('invalid_response');
      }
      boundedString(target.name, 256, 'invalid_response');
    }
  }
  if (
    Object.hasOwn(record, 'status_code') &&
    (typeof record.status_code !== 'number' ||
      !Number.isInteger(record.status_code) ||
      record.status_code < 100 ||
      record.status_code > 599)
  ) {
    fail('invalid_response');
  }
}

function validateTextResponse(body: unknown): IbmWatsonxAiTextResponse {
  assertSafeData(body, 'invalid_response');
  const record = exactRecord(body, ['model_id', 'created_at', 'results'], [], 'invalid_response');
  const modelId = boundedString(
    record.model_id,
    IBM_WATSONX_AI_LIMITS.modelIdBytes,
    'invalid_response',
  );
  const createdAt = boundedString(record.created_at, 256, 'invalid_response');
  if (!RFC3339_PATTERN.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    fail('invalid_response');
  }
  if (
    !Array.isArray(record.results) ||
    record.results.length < 1 ||
    record.results.length > IBM_WATSONX_AI_LIMITS.textResults
  ) {
    fail('invalid_response');
  }
  const results = record.results.map((value) => {
    const result = exactRecord(
      value,
      ['generated_text', 'stop_reason'],
      ['generated_token_count', 'input_token_count'],
      'invalid_response',
    );
    const generatedText = boundedString(
      result.generated_text,
      IBM_WATSONX_AI_LIMITS.responseStringBytes,
      'invalid_response',
    );
    if (typeof result.stop_reason !== 'string' || !STOP_REASONS.has(result.stop_reason)) {
      fail('invalid_response');
    }
    const output: {
      generatedText: string;
      stopReason: string;
      generatedTokenCount?: number;
      inputTokenCount?: number;
    } = {
      generatedText,
      stopReason: result.stop_reason,
    };
    for (const [providerKey, localKey] of [
      ['generated_token_count', 'generatedTokenCount'],
      ['input_token_count', 'inputTokenCount'],
    ] as const) {
      if (Object.hasOwn(result, providerKey)) {
        const count = result[providerKey];
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
          fail('invalid_response');
        }
        output[localKey] = count;
      }
    }
    return Object.freeze(output);
  });
  return Object.freeze({
    modelId,
    createdAt,
    results: Object.freeze(results),
  });
}

function validateImageResponse(body: unknown): Uint8Array {
  if (!(body instanceof Uint8Array)) fail('invalid_response');
  if (body.byteLength < 1 || body.byteLength > IBM_WATSONX_AI_LIMITS.imageBytes) {
    fail('invalid_response');
  }
  return new Uint8Array(body);
}

export function createIbmWatsonxAiConnector(
  configuration: IbmWatsonxAiConfiguration,
): Readonly<IbmWatsonxAiConnector> {
  const config = normalizeValidation('invalid_configuration', () =>
    validateConfiguration(configuration),
  );

  const execute = async (
    operation: 'text' | 'image',
    untrustedRequest: IbmWatsonxAiOperationRequest,
  ): Promise<IbmWatsonxAiTextResponse | Uint8Array> => {
    const request = normalizeValidation('invalid_request', () =>
      validateOperationRequest(untrustedRequest),
    );
    const controller = new AbortController();
    const headers = Object.freeze({
      Authorization: `Bearer ${config.bearerToken}`,
      Accept: operation === 'text' ? 'application/json' : 'image/png',
      'Content-Type': 'application/json',
    });
    const transportRequest = Object.freeze({
      method: 'POST' as const,
      url: `${config.baseUrl}${operation === 'text' ? TEXT_PATH : IMAGE_PATH}?version=${config.apiVersion}`,
      headers,
      body: createBody(request),
      signal: controller.signal,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new IbmWatsonxAiError('timeout'));
      }, config.timeoutMs);
    });

    let raw: unknown;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() => config.transport(transportRequest)),
        timeout,
      ]);
    } catch (error: unknown) {
      if (error instanceof IbmWatsonxAiError) throw error;
      throw new IbmWatsonxAiError('transport_error');
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    const response = normalizeValidation('invalid_response', () =>
      validateTransportEnvelope(raw),
    );
    if ([400, 401, 403, 404].includes(response.status)) {
      if (!validMediaType(response.contentType, 'application/json')) fail('invalid_response');
      normalizeValidation('invalid_response', () => validateProviderError(response.body));
      throw new IbmWatsonxAiError('provider_error', response.status);
    }
    if (response.status !== 200) {
      throw new IbmWatsonxAiError('unexpected_response', response.status);
    }
    if (operation === 'text') {
      if (!validMediaType(response.contentType, 'application/json')) fail('invalid_response');
      return normalizeValidation('invalid_response', () => validateTextResponse(response.body));
    }
    if (!validMediaType(response.contentType, 'image/png')) fail('invalid_response');
    return normalizeValidation('invalid_response', () => validateImageResponse(response.body));
  };

  return Object.freeze({
    generateText: async (request: IbmWatsonxAiOperationRequest) =>
      (await execute('text', request)) as IbmWatsonxAiTextResponse,
    generateImage: async (request: IbmWatsonxAiOperationRequest) =>
      (await execute('image', request)) as Uint8Array,
  });
}
