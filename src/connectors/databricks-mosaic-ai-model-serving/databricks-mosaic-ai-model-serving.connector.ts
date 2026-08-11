export const DATABRICKS_MOSAIC_AI_MODEL_SERVING_API_VERSION = '2.0' as const;

export const DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  originBytes: 2_048,
  hostnameBytes: 253,
  identifierBytes: 256,
  headerValueBytes: 256,
  stringBytes: 65_536,
  totalJsonBytes: 1_048_576,
  jsonDepth: 12,
  recordKeys: 128,
  arrayItems: 1_024,
  visitedNodes: 8_192,
});

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ENDPOINT_NAME = /^[A-Za-z0-9_-]{1,63}$/;
const IPV4_LITERAL = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const JSON_MEDIA_TYPE =
  /^application\/json(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=[!#$%&'*+.^_`|~0-9A-Za-z-]+)*$/i;

export type DatabricksMosaicAiCloud = 'aws' | 'azure' | 'gcp';
export type DatabricksMosaicAiJsonPrimitive = string | number | boolean | null;
export type DatabricksMosaicAiJsonValue =
  | DatabricksMosaicAiJsonPrimitive
  | readonly DatabricksMosaicAiJsonValue[]
  | Readonly<{ [key: string]: DatabricksMosaicAiJsonValue }>;
export type DatabricksMosaicAiJsonObject = Readonly<{
  [key: string]: DatabricksMosaicAiJsonValue;
}>;

export type DatabricksMosaicAiModelServingErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'invalid_response'
  | 'provider_error'
  | 'unexpected_response'
  | 'transport_error'
  | 'timeout';

const ERROR_MESSAGES: Readonly<Record<DatabricksMosaicAiModelServingErrorCode, string>> =
  Object.freeze({
    invalid_configuration: 'Databricks Mosaic AI Model Serving configuration is invalid',
    invalid_request: 'Databricks Mosaic AI Model Serving request is invalid',
    invalid_response: 'Databricks Mosaic AI Model Serving response is invalid',
    provider_error: 'Databricks Mosaic AI Model Serving rejected the request',
    unexpected_response: 'Databricks Mosaic AI Model Serving returned an unexpected status',
    transport_error: 'Databricks Mosaic AI Model Serving transport failed',
    timeout: 'Databricks Mosaic AI Model Serving request timed out',
  });

export class DatabricksMosaicAiModelServingError extends Error {
  readonly code: DatabricksMosaicAiModelServingErrorCode;
  readonly status?: number;

  constructor(code: DatabricksMosaicAiModelServingErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DatabricksMosaicAiModelServingError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface DatabricksMosaicAiTransportRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: DatabricksMosaicAiJsonObject;
  readonly signal: AbortSignal;
}

export interface DatabricksMosaicAiTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type DatabricksMosaicAiAuthorizedTransport = (
  request: Readonly<DatabricksMosaicAiTransportRequest>,
) => Promise<DatabricksMosaicAiTransportResponse>;

export interface DatabricksMosaicAiModelServingConfiguration {
  readonly cloud: DatabricksMosaicAiCloud;
  readonly workspaceOrigin: string;
  readonly apiVersion: typeof DATABRICKS_MOSAIC_AI_MODEL_SERVING_API_VERSION;
  readonly timeoutMs: number;
  readonly transport: DatabricksMosaicAiAuthorizedTransport;
}

export interface DatabricksMosaicAiEndpointRequest {
  readonly endpointName: string;
}

export interface DatabricksMosaicAiInvocationRequest extends DatabricksMosaicAiEndpointRequest {
  readonly body: unknown;
}

export type DatabricksMosaicAiListEndpointsRequest = Readonly<Record<never, never>>;

export interface DatabricksMosaicAiResponse {
  readonly body: DatabricksMosaicAiJsonObject;
  readonly servedModelNameHeader?: string;
}

export interface DatabricksMosaicAiModelServingConnector {
  invoke(request: DatabricksMosaicAiInvocationRequest): Promise<DatabricksMosaicAiResponse>;
  listEndpoints(request: DatabricksMosaicAiListEndpointsRequest): Promise<DatabricksMosaicAiResponse>;
  getEndpoint(request: DatabricksMosaicAiEndpointRequest): Promise<DatabricksMosaicAiResponse>;
  getEndpointOpenApi(
    request: DatabricksMosaicAiEndpointRequest,
  ): Promise<DatabricksMosaicAiResponse>;
}

type ValidationCode = 'invalid_configuration' | 'invalid_request' | 'invalid_response';

function fail(code: ValidationCode): never {
  throw new DatabricksMosaicAiModelServingError(code);
}

function normalizeValidation<T>(code: ValidationCode, validate: () => T): T {
  try {
    return validate();
  } catch (error: unknown) {
    if (error instanceof DatabricksMosaicAiModelServingError && error.code === code) {
      throw error;
    }
    throw new DatabricksMosaicAiModelServingError(code);
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
  if (ownKeys.length > DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.recordKeys) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = {};
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

function cloneSafeJson(value: unknown, code: ValidationCode): DatabricksMosaicAiJsonValue {
  const ancestors = new WeakSet<object>();
  let visited = 0;

  const visit = (current: unknown, depth: number): DatabricksMosaicAiJsonValue => {
    visited += 1;
    if (visited > DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.visitedNodes) fail(code);
    if (depth > DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.jsonDepth) fail(code);
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(code);
      return current;
    }
    if (typeof current === 'string') {
      if (utf8Bytes(current) > DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.stringBytes) {
        fail(code);
      }
      return current;
    }
    if (typeof current !== 'object') fail(code);
    if (ancestors.has(current)) fail(code);
    ancestors.add(current);
    let copy: DatabricksMosaicAiJsonValue;
    if (Array.isArray(current)) {
      if (current.length > DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.arrayItems) fail(code);
      copy = Object.freeze(current.map((item) => visit(item, depth + 1)));
    } else {
      const record = readDataRecord(current, code);
      const objectCopy: Record<string, DatabricksMosaicAiJsonValue> = {};
      for (const [key, item] of Object.entries(record)) {
        objectCopy[key] = visit(item, depth + 1);
      }
      copy = Object.freeze(objectCopy);
    }
    ancestors.delete(current);
    return copy;
  };

  const copy = visit(value, 0);
  const encoded = JSON.stringify(copy);
  if (
    encoded === undefined ||
    utf8Bytes(encoded) > DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.totalJsonBytes
  ) {
    fail(code);
  }
  return copy;
}

function isDatabricksMosaicAiJsonArray(
  value: DatabricksMosaicAiJsonValue,
): value is readonly DatabricksMosaicAiJsonValue[] {
  return Array.isArray(value);
}

function cloneSafeJsonObject(
  value: unknown,
  code: ValidationCode,
): DatabricksMosaicAiJsonObject {
  const copy = cloneSafeJson(value, code);
  if (copy === null || typeof copy !== 'object' || isDatabricksMosaicAiJsonArray(copy)) fail(code);
  return copy;
}

function validateWorkspaceOrigin(value: unknown): string {
  const original = boundedString(
    value,
    DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.originBytes,
    'invalid_configuration',
  );
  let parsed: URL;
  try {
    parsed = new URL(original);
  } catch {
    fail('invalid_configuration');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    fail('invalid_configuration');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    utf8Bytes(hostname) > DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.hostnameBytes ||
    hostname.includes(':') ||
    hostname.includes('[') ||
    IPV4_LITERAL.test(hostname) ||
    !hostname.includes('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'serving.cloud.databricks.com' ||
    hostname.endsWith('.serving.cloud.databricks.com') ||
    hostname === 'serving.azuredatabricks.net' ||
    hostname.endsWith('.serving.azuredatabricks.net') ||
    hostname.split('.').some((label) => !DNS_LABEL.test(label))
  ) {
    fail('invalid_configuration');
  }
  return parsed.origin;
}

function validateConfiguration(value: unknown): Readonly<{
  cloud: DatabricksMosaicAiCloud;
  workspaceOrigin: string;
  timeoutMs: number;
  transport: DatabricksMosaicAiAuthorizedTransport;
}> {
  const record = exactRecord(
    value,
    ['cloud', 'workspaceOrigin', 'apiVersion', 'timeoutMs', 'transport'],
    [],
    'invalid_configuration',
  );
  if (record.cloud !== 'aws' && record.cloud !== 'azure' && record.cloud !== 'gcp') {
    fail('invalid_configuration');
  }
  if (record.apiVersion !== DATABRICKS_MOSAIC_AI_MODEL_SERVING_API_VERSION) {
    fail('invalid_configuration');
  }
  if (
    typeof record.timeoutMs !== 'number' ||
    !Number.isInteger(record.timeoutMs) ||
    record.timeoutMs < 1 ||
    record.timeoutMs > DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.timeoutMs
  ) {
    fail('invalid_configuration');
  }
  if (typeof record.transport !== 'function') fail('invalid_configuration');
  return Object.freeze({
    cloud: record.cloud,
    workspaceOrigin: validateWorkspaceOrigin(record.workspaceOrigin),
    timeoutMs: record.timeoutMs,
    transport: record.transport as DatabricksMosaicAiAuthorizedTransport,
  });
}

function validateEndpointName(value: unknown): string {
  const endpointName = boundedString(
    value,
    DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.identifierBytes,
    'invalid_request',
  );
  if (!ENDPOINT_NAME.test(endpointName)) fail('invalid_request');
  return endpointName;
}

function validJsonMediaType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && JSON_MEDIA_TYPE.test(value);
}

function validateTransportResponse(
  value: unknown,
  allowServedModelName: boolean,
): {
  status: number;
  body: DatabricksMosaicAiJsonObject;
  servedModelNameHeader?: string;
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
  const headers = exactRecord(
    record.headers,
    ['content-type'],
    allowServedModelName ? ['served-model-name'] : [],
    'invalid_response',
  );
  if (!validJsonMediaType(headers['content-type'])) fail('invalid_response');
  let servedModelNameHeader: string | undefined;
  if (headers['served-model-name'] !== undefined) {
    servedModelNameHeader = boundedString(
      headers['served-model-name'],
      DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.headerValueBytes,
      'invalid_response',
    );
  }
  const body = cloneSafeJsonObject(record.body, 'invalid_response');
  return { status: record.status, body, servedModelNameHeader };
}

function createResult(
  body: DatabricksMosaicAiJsonObject,
  servedModelNameHeader?: string,
): Readonly<DatabricksMosaicAiResponse> {
  if (servedModelNameHeader === undefined) return Object.freeze({ body });
  return Object.freeze({ body, servedModelNameHeader });
}

export function createDatabricksMosaicAiModelServingConnector(
  configuration: DatabricksMosaicAiModelServingConfiguration,
): Readonly<DatabricksMosaicAiModelServingConnector> {
  const config = normalizeValidation('invalid_configuration', () =>
    validateConfiguration(configuration),
  );
  const managementRoot = `${config.workspaceOrigin}/api/${DATABRICKS_MOSAIC_AI_MODEL_SERVING_API_VERSION}/serving-endpoints`;
  const invocationRoot = `${config.workspaceOrigin}/serving-endpoints`;

  const execute = async (
    descriptor: Omit<DatabricksMosaicAiTransportRequest, 'signal'>,
    allowServedModelName: boolean,
  ): Promise<Readonly<DatabricksMosaicAiResponse>> => {
    const controller = new AbortController();
    const request = Object.freeze({ ...descriptor, signal: controller.signal });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new DatabricksMosaicAiModelServingError('timeout'));
      }, config.timeoutMs);
    });

    let raw: unknown;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() => config.transport(request)),
        timeout,
      ]);
    } catch (error: unknown) {
      if (error instanceof DatabricksMosaicAiModelServingError) throw error;
      throw new DatabricksMosaicAiModelServingError('transport_error');
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    const parsed = normalizeValidation('invalid_response', () =>
      validateTransportResponse(raw, allowServedModelName),
    );
    if (parsed.status >= 400) {
      throw new DatabricksMosaicAiModelServingError('provider_error', parsed.status);
    }
    if (parsed.status !== 200) {
      throw new DatabricksMosaicAiModelServingError('unexpected_response', parsed.status);
    }
    return createResult(parsed.body, parsed.servedModelNameHeader);
  };

  const endpointNameFrom = (value: unknown): string => {
    const record = exactRecord(value, ['endpointName'], [], 'invalid_request');
    return validateEndpointName(record.endpointName);
  };

  const connector: DatabricksMosaicAiModelServingConnector = {
    invoke: async (value: DatabricksMosaicAiInvocationRequest) => {
      const record = normalizeValidation('invalid_request', () =>
        exactRecord(value, ['endpointName', 'body'], [], 'invalid_request'),
      );
      const endpointName = validateEndpointName(record.endpointName);
      const body = cloneSafeJsonObject(record.body, 'invalid_request');
      if (Object.hasOwn(body, 'stream') && body.stream === true) fail('invalid_request');
      return execute(
        {
          method: 'POST',
          url: `${invocationRoot}/${encodeURIComponent(endpointName)}/invocations`,
          headers: Object.freeze({
            accept: 'application/json',
            'content-type': 'application/json',
          }),
          body,
        },
        true,
      );
    },
    listEndpoints: async (value: DatabricksMosaicAiListEndpointsRequest) => {
      normalizeValidation('invalid_request', () =>
        exactRecord(value, [], [], 'invalid_request'),
      );
      return execute(
        {
          method: 'GET',
          url: managementRoot,
          headers: Object.freeze({ accept: 'application/json' }),
        },
        false,
      );
    },
    getEndpoint: async (value: DatabricksMosaicAiEndpointRequest) => {
      const endpointName = normalizeValidation('invalid_request', () =>
        endpointNameFrom(value),
      );
      return execute(
        {
          method: 'GET',
          url: `${managementRoot}/${encodeURIComponent(endpointName)}`,
          headers: Object.freeze({ accept: 'application/json' }),
        },
        false,
      );
    },
    getEndpointOpenApi: async (value: DatabricksMosaicAiEndpointRequest) => {
      const endpointName = normalizeValidation('invalid_request', () =>
        endpointNameFrom(value),
      );
      return execute(
        {
          method: 'GET',
          url: `${managementRoot}/${encodeURIComponent(endpointName)}/openapi`,
          headers: Object.freeze({ accept: 'application/json' }),
        },
        false,
      );
    },
  };

  return Object.freeze(connector);
}
