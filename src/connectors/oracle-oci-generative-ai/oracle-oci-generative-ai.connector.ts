export const ORACLE_OCI_GENERATIVE_AI_API_VERSION = '20231130' as const;

export const ORACLE_OCI_GENERATIVE_AI_REGIONS = Object.freeze({
  'sa-saopaulo-1': 'oraclecloud.com',
  'eu-frankfurt-1': 'oraclecloud.com',
  'ap-hyderabad-1': 'oraclecloud.com',
  'ap-osaka-1': 'oraclecloud.com',
  'me-riyadh-1': 'oraclecloud.com',
  'me-abudhabi-1': 'oraclecloud.com',
  'me-dubai-1': 'oraclecloud.com',
  'uk-london-1': 'oraclecloud.com',
  'us-ashburn-1': 'oraclecloud.com',
  'us-chicago-1': 'oraclecloud.com',
  'us-phoenix-1': 'oraclecloud.com',
  'uk-gov-london-1': 'oraclegovcloud.uk',
  'eu-frankfurt-2': 'oraclecloud.eu',
} as const);

export const ORACLE_OCI_GENERATIVE_AI_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  identifierBytes: 512,
  pageBytes: 2_048,
  stringBytes: 65_536,
  totalJsonBytes: 1_048_576,
  jsonDepth: 12,
  recordKeys: 64,
  arrayItems: 256,
  visitedNodes: 4_096,
  listLimit: 100,
});

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const JSON_MEDIA_TYPE =
  /^application\/json(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=[!#$%&'*+.^_`|~0-9A-Za-z-]+)*$/i;
const COMPARTMENT_OCID = /^ocid1\.compartment\.[A-Za-z0-9.-]+$/;
const WORK_REQUEST_OCID = /^ocid1\.workrequest\.[A-Za-z0-9.-]+$/;

const INFERENCE_PATHS = Object.freeze({
  applyGuardrails: '/actions/applyGuardrails',
  chat: '/actions/chat',
  embedText: '/actions/embedText',
  generateText: '/actions/generateText',
  rerankText: '/actions/rerankText',
  summarizeText: '/actions/summarizeText',
} as const);

const GUARDRAIL_STATES = new Set(['ACTIVE', 'PREVIEW', 'DEPRECATED', 'RETIRED']);
const MODEL_STATES = new Set(['ACTIVE', 'CREATING', 'DELETING', 'DELETED', 'FAILED']);
const ENDPOINT_STATES = new Set([
  'ACTIVE',
  'CREATING',
  'UPDATING',
  'DELETING',
  'DELETED',
  'FAILED',
]);
const MODEL_CAPABILITIES = new Set([
  'TEXT_GENERATION',
  'TEXT_SUMMARIZATION',
  'TEXT_EMBEDDINGS',
  'FINE_TUNE',
  'CHAT',
  'TEXT_RERANK',
  'TEXT_TO_IMAGE',
  'IMAGE_TEXT_TO_IMAGE',
  'IMAGE_TEXT_TO_TEXT',
  'IMAGE_TEXT_TO_VIDEO',
  'IMAGE_TO_IMAGE',
  'REALTIME',
  'AUDIO_TO_AUDIO',
  'AUDIO_TO_TEXT',
  'TEXT_TO_AUDIO',
  'TEXT_TO_VIDEO',
]);

export type OracleOciGenerativeAiRegion = keyof typeof ORACLE_OCI_GENERATIVE_AI_REGIONS;

export type OracleOciJsonPrimitive = string | number | boolean | null;
export type OracleOciJsonValue =
  | OracleOciJsonPrimitive
  | readonly OracleOciJsonValue[]
  | Readonly<{ [key: string]: OracleOciJsonValue }>;

export type OracleOciGenerativeAiErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'invalid_response'
  | 'provider_error'
  | 'unexpected_response'
  | 'transport_error'
  | 'timeout';

const ERROR_MESSAGES: Readonly<Record<OracleOciGenerativeAiErrorCode, string>> = Object.freeze({
  invalid_configuration: 'Oracle OCI Generative AI configuration is invalid',
  invalid_request: 'Oracle OCI Generative AI request is invalid',
  invalid_response: 'Oracle OCI Generative AI response is invalid',
  provider_error: 'Oracle OCI Generative AI rejected the request',
  unexpected_response: 'Oracle OCI Generative AI returned an unexpected status',
  transport_error: 'Oracle OCI Generative AI transport failed',
  timeout: 'Oracle OCI Generative AI request timed out',
});

export class OracleOciGenerativeAiError extends Error {
  readonly code: OracleOciGenerativeAiErrorCode;
  readonly status?: number;

  constructor(code: OracleOciGenerativeAiErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OracleOciGenerativeAiError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface OracleOciTransportRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: OracleOciJsonValue;
  readonly signal: AbortSignal;
}

export interface OracleOciTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type OracleOciAuthorizedTransport = (
  request: Readonly<OracleOciTransportRequest>,
) => Promise<OracleOciTransportResponse>;

export interface OracleOciGenerativeAiConfiguration {
  readonly region: OracleOciGenerativeAiRegion;
  readonly apiVersion: typeof ORACLE_OCI_GENERATIVE_AI_API_VERSION;
  readonly timeoutMs: number;
  readonly transport: OracleOciAuthorizedTransport;
}

export interface OracleOciJsonDocumentRequest {
  readonly body: unknown;
}

export interface OracleOciGuardrailVersionsRequest {
  readonly compartmentId: string;
  readonly state?: 'ACTIVE' | 'PREVIEW' | 'DEPRECATED' | 'RETIRED';
  readonly limit?: number;
  readonly page?: string;
}

export interface OracleOciListModelsRequest {
  readonly compartmentId: string;
  readonly capability?: string;
  readonly lifecycleState?: 'ACTIVE' | 'CREATING' | 'DELETING' | 'DELETED' | 'FAILED';
  readonly limit?: number;
  readonly page?: string;
}

export interface OracleOciListEndpointsRequest {
  readonly compartmentId: string;
  readonly lifecycleState?:
    | 'ACTIVE'
    | 'CREATING'
    | 'UPDATING'
    | 'DELETING'
    | 'DELETED'
    | 'FAILED';
  readonly limit?: number;
  readonly page?: string;
}

export interface OracleOciWorkRequestRequest {
  readonly workRequestId: string;
}

export interface OracleOciWorkRequestCollectionRequest extends OracleOciWorkRequestRequest {
  readonly limit?: number;
  readonly page?: string;
}

export interface OracleOciJsonResponse {
  readonly body: OracleOciJsonValue;
  readonly opcRequestId?: string;
  readonly nextPage?: string;
}

export interface OracleOciGenerativeAiConnector {
  applyGuardrails(request: OracleOciJsonDocumentRequest): Promise<OracleOciJsonResponse>;
  chat(request: OracleOciJsonDocumentRequest): Promise<OracleOciJsonResponse>;
  embedText(request: OracleOciJsonDocumentRequest): Promise<OracleOciJsonResponse>;
  generateText(request: OracleOciJsonDocumentRequest): Promise<OracleOciJsonResponse>;
  listGuardrailVersions(
    request: OracleOciGuardrailVersionsRequest,
  ): Promise<OracleOciJsonResponse>;
  rerankText(request: OracleOciJsonDocumentRequest): Promise<OracleOciJsonResponse>;
  summarizeText(request: OracleOciJsonDocumentRequest): Promise<OracleOciJsonResponse>;
  listModels(request: OracleOciListModelsRequest): Promise<OracleOciJsonResponse>;
  listEndpoints(request: OracleOciListEndpointsRequest): Promise<OracleOciJsonResponse>;
  getWorkRequest(request: OracleOciWorkRequestRequest): Promise<OracleOciJsonResponse>;
  listWorkRequestErrors(
    request: OracleOciWorkRequestCollectionRequest,
  ): Promise<OracleOciJsonResponse>;
  listWorkRequestLogs(
    request: OracleOciWorkRequestCollectionRequest,
  ): Promise<OracleOciJsonResponse>;
}

type ValidationCode = 'invalid_configuration' | 'invalid_request' | 'invalid_response';

function fail(code: ValidationCode): never {
  throw new OracleOciGenerativeAiError(code);
}

function normalizeValidation<T>(code: ValidationCode, validate: () => T): T {
  try {
    return validate();
  } catch (error: unknown) {
    if (error instanceof OracleOciGenerativeAiError && error.code === code) throw error;
    throw new OracleOciGenerativeAiError(code);
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
  if (ownKeys.length > ORACLE_OCI_GENERATIVE_AI_LIMITS.recordKeys) fail(code);
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

function optionalBoundedString(
  value: unknown,
  maximumBytes: number,
  code: ValidationCode,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, maximumBytes, code);
}

function cloneSafeJson(value: unknown, code: ValidationCode): OracleOciJsonValue {
  const ancestors = new WeakSet<object>();
  let visited = 0;

  const visit = (current: unknown, depth: number): OracleOciJsonValue => {
    visited += 1;
    if (visited > ORACLE_OCI_GENERATIVE_AI_LIMITS.visitedNodes) fail(code);
    if (depth > ORACLE_OCI_GENERATIVE_AI_LIMITS.jsonDepth) fail(code);
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(code);
      return current;
    }
    if (typeof current === 'string') {
      if (utf8Bytes(current) > ORACLE_OCI_GENERATIVE_AI_LIMITS.stringBytes) fail(code);
      return current;
    }
    if (typeof current !== 'object') fail(code);
    if (ancestors.has(current)) fail(code);
    ancestors.add(current);
    let copy: OracleOciJsonValue;
    if (Array.isArray(current)) {
      if (current.length > ORACLE_OCI_GENERATIVE_AI_LIMITS.arrayItems) fail(code);
      copy = Object.freeze(current.map((item) => visit(item, depth + 1)));
    } else {
      const record = readDataRecord(current, code);
      const objectCopy: Record<string, OracleOciJsonValue> = {};
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
  if (encoded === undefined || utf8Bytes(encoded) > ORACLE_OCI_GENERATIVE_AI_LIMITS.totalJsonBytes) {
    fail(code);
  }
  return copy;
}

function validateConfiguration(value: unknown): Readonly<OracleOciGenerativeAiConfiguration> {
  const record = exactRecord(
    value,
    ['region', 'apiVersion', 'timeoutMs', 'transport'],
    [],
    'invalid_configuration',
  );
  if (
    typeof record.region !== 'string' ||
    !Object.hasOwn(ORACLE_OCI_GENERATIVE_AI_REGIONS, record.region)
  ) {
    fail('invalid_configuration');
  }
  if (record.apiVersion !== ORACLE_OCI_GENERATIVE_AI_API_VERSION) {
    fail('invalid_configuration');
  }
  if (
    typeof record.timeoutMs !== 'number' ||
    !Number.isInteger(record.timeoutMs) ||
    record.timeoutMs < 1 ||
    record.timeoutMs > ORACLE_OCI_GENERATIVE_AI_LIMITS.timeoutMs
  ) {
    fail('invalid_configuration');
  }
  if (typeof record.transport !== 'function') fail('invalid_configuration');
  return Object.freeze({
    region: record.region as OracleOciGenerativeAiRegion,
    apiVersion: ORACLE_OCI_GENERATIVE_AI_API_VERSION,
    timeoutMs: record.timeoutMs,
    transport: record.transport as OracleOciAuthorizedTransport,
  });
}

function validateJsonDocumentRequest(value: unknown): OracleOciJsonValue {
  const record = exactRecord(value, ['body'], [], 'invalid_request');
  return cloneSafeJson(record.body, 'invalid_request');
}

function validateCompartmentId(value: unknown): string {
  const id = boundedString(
    value,
    ORACLE_OCI_GENERATIVE_AI_LIMITS.identifierBytes,
    'invalid_request',
  );
  if (!COMPARTMENT_OCID.test(id)) fail('invalid_request');
  return id;
}

function validateWorkRequestId(value: unknown): string {
  const id = boundedString(
    value,
    ORACLE_OCI_GENERATIVE_AI_LIMITS.identifierBytes,
    'invalid_request',
  );
  if (!WORK_REQUEST_OCID.test(id)) fail('invalid_request');
  return id;
}

function validateLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > ORACLE_OCI_GENERATIVE_AI_LIMITS.listLimit
  ) {
    fail('invalid_request');
  }
  return value;
}

function validatePage(value: unknown): string | undefined {
  return optionalBoundedString(
    value,
    ORACLE_OCI_GENERATIVE_AI_LIMITS.pageBytes,
    'invalid_request',
  );
}

function validateEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) fail('invalid_request');
  return value;
}

function buildQuery(entries: readonly (readonly [string, string | number | undefined])[]): string {
  const present = entries.filter((entry): entry is readonly [string, string | number] => {
    return entry[1] !== undefined;
  });
  if (present.length === 0) return '';
  return `?${present
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')}`;
}

function inferenceBase(region: OracleOciGenerativeAiRegion): string {
  return `https://inference.generativeai.${region}.oci.${ORACLE_OCI_GENERATIVE_AI_REGIONS[region]}`;
}

function managementBase(region: OracleOciGenerativeAiRegion): string {
  return `https://generativeai.${region}.oci.${ORACLE_OCI_GENERATIVE_AI_REGIONS[region]}`;
}

function validJsonMediaType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && JSON_MEDIA_TYPE.test(value);
}

function validateTransportResponse(
  value: unknown,
  paginated: boolean,
): {
  status: number;
  body: OracleOciJsonValue;
  opcRequestId?: string;
  nextPage?: string;
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
    paginated ? ['opc-request-id', 'opc-next-page'] : ['opc-request-id'],
    'invalid_response',
  );
  if (!validJsonMediaType(headers['content-type'])) fail('invalid_response');
  const opcRequestId = optionalBoundedString(headers['opc-request-id'], 256, 'invalid_response');
  const nextPage = optionalBoundedString(
    headers['opc-next-page'],
    ORACLE_OCI_GENERATIVE_AI_LIMITS.pageBytes,
    'invalid_response',
  );
  const body = cloneSafeJson(record.body, 'invalid_response');
  return { status: record.status, body, opcRequestId, nextPage };
}

function createResult(
  body: OracleOciJsonValue,
  opcRequestId?: string,
  nextPage?: string,
): Readonly<OracleOciJsonResponse> {
  const result: {
    body: OracleOciJsonValue;
    opcRequestId?: string;
    nextPage?: string;
  } = { body };
  if (opcRequestId !== undefined) result.opcRequestId = opcRequestId;
  if (nextPage !== undefined) result.nextPage = nextPage;
  return Object.freeze(result);
}

export function createOracleOciGenerativeAiConnector(
  configuration: OracleOciGenerativeAiConfiguration,
): Readonly<OracleOciGenerativeAiConnector> {
  const config = normalizeValidation('invalid_configuration', () =>
    validateConfiguration(configuration),
  );
  const inferenceRoot = `${inferenceBase(config.region)}/${config.apiVersion}`;
  const managementRoot = `${managementBase(config.region)}/${config.apiVersion}`;

  const execute = async (
    descriptor: Omit<OracleOciTransportRequest, 'signal'>,
    paginated: boolean,
  ): Promise<Readonly<OracleOciJsonResponse>> => {
    const controller = new AbortController();
    const request = Object.freeze({ ...descriptor, signal: controller.signal });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new OracleOciGenerativeAiError('timeout'));
      }, config.timeoutMs);
    });

    let raw: unknown;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() => config.transport(request)),
        timeout,
      ]);
    } catch (error: unknown) {
      if (error instanceof OracleOciGenerativeAiError) throw error;
      throw new OracleOciGenerativeAiError('transport_error');
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    const parsed = normalizeValidation('invalid_response', () =>
      validateTransportResponse(raw, paginated),
    );
    if (parsed.status >= 400) {
      throw new OracleOciGenerativeAiError('provider_error', parsed.status);
    }
    if (parsed.status !== 200) {
      throw new OracleOciGenerativeAiError('unexpected_response', parsed.status);
    }
    return createResult(parsed.body, parsed.opcRequestId, parsed.nextPage);
  };

  const postInference = async (
    operation: keyof typeof INFERENCE_PATHS,
    untrustedRequest: OracleOciJsonDocumentRequest,
  ): Promise<Readonly<OracleOciJsonResponse>> => {
    const body = normalizeValidation('invalid_request', () =>
      validateJsonDocumentRequest(untrustedRequest),
    );
    return execute(
      {
        method: 'POST',
        url: `${inferenceRoot}${INFERENCE_PATHS[operation]}`,
        headers: Object.freeze({
          accept: 'application/json',
          'content-type': 'application/json',
        }),
        body,
      },
      false,
    );
  };

  const listGuardrailVersions = async (
    value: OracleOciGuardrailVersionsRequest,
  ): Promise<Readonly<OracleOciJsonResponse>> => {
    const record = normalizeValidation('invalid_request', () =>
      exactRecord(
        value,
        ['compartmentId'],
        ['state', 'limit', 'page'],
        'invalid_request',
      ),
    );
    const compartmentId = validateCompartmentId(record.compartmentId);
    const state = validateEnum(record.state, GUARDRAIL_STATES);
    const limit = validateLimit(record.limit);
    const page = validatePage(record.page);
    return execute(
      {
        method: 'GET',
        url: `${inferenceRoot}/guardrailVersions${buildQuery([
          ['state', state],
          ['limit', limit],
          ['page', page],
        ])}`,
        headers: Object.freeze({
          accept: 'application/json',
          'opc-compartment-id': compartmentId,
        }),
      },
      true,
    );
  };

  const listModels = async (
    value: OracleOciListModelsRequest,
  ): Promise<Readonly<OracleOciJsonResponse>> => {
    const record = normalizeValidation('invalid_request', () =>
      exactRecord(
        value,
        ['compartmentId'],
        ['capability', 'lifecycleState', 'limit', 'page'],
        'invalid_request',
      ),
    );
    const compartmentId = validateCompartmentId(record.compartmentId);
    const capability = validateEnum(record.capability, MODEL_CAPABILITIES);
    const lifecycleState = validateEnum(record.lifecycleState, MODEL_STATES);
    const limit = validateLimit(record.limit);
    const page = validatePage(record.page);
    return execute(
      {
        method: 'GET',
        url: `${managementRoot}/models${buildQuery([
          ['compartmentId', compartmentId],
          ['capability', capability],
          ['lifecycleState', lifecycleState],
          ['limit', limit],
          ['page', page],
        ])}`,
        headers: Object.freeze({ accept: 'application/json' }),
      },
      true,
    );
  };

  const listEndpoints = async (
    value: OracleOciListEndpointsRequest,
  ): Promise<Readonly<OracleOciJsonResponse>> => {
    const record = normalizeValidation('invalid_request', () =>
      exactRecord(
        value,
        ['compartmentId'],
        ['lifecycleState', 'limit', 'page'],
        'invalid_request',
      ),
    );
    const compartmentId = validateCompartmentId(record.compartmentId);
    const lifecycleState = validateEnum(record.lifecycleState, ENDPOINT_STATES);
    const limit = validateLimit(record.limit);
    const page = validatePage(record.page);
    return execute(
      {
        method: 'GET',
        url: `${managementRoot}/endpoints${buildQuery([
          ['compartmentId', compartmentId],
          ['lifecycleState', lifecycleState],
          ['limit', limit],
          ['page', page],
        ])}`,
        headers: Object.freeze({ accept: 'application/json' }),
      },
      true,
    );
  };

  const observeWorkRequest = async (
    value: OracleOciWorkRequestRequest | OracleOciWorkRequestCollectionRequest,
    suffix: '' | '/errors' | '/logs',
  ): Promise<Readonly<OracleOciJsonResponse>> => {
    const paginated = suffix !== '';
    const record = normalizeValidation('invalid_request', () =>
      exactRecord(
        value,
        ['workRequestId'],
        paginated ? ['limit', 'page'] : [],
        'invalid_request',
      ),
    );
    const workRequestId = validateWorkRequestId(record.workRequestId);
    const limit = paginated ? validateLimit(record.limit) : undefined;
    const page = paginated ? validatePage(record.page) : undefined;
    return execute(
      {
        method: 'GET',
        url:
          `${managementRoot}/workRequests/${encodeURIComponent(workRequestId)}${suffix}` +
          buildQuery([
            ['limit', limit],
            ['page', page],
          ]),
        headers: Object.freeze({ accept: 'application/json' }),
      },
      paginated,
    );
  };

  return Object.freeze({
    applyGuardrails: (request: OracleOciJsonDocumentRequest) =>
      postInference('applyGuardrails', request),
    chat: (request: OracleOciJsonDocumentRequest) => postInference('chat', request),
    embedText: (request: OracleOciJsonDocumentRequest) => postInference('embedText', request),
    generateText: (request: OracleOciJsonDocumentRequest) =>
      postInference('generateText', request),
    listGuardrailVersions,
    rerankText: (request: OracleOciJsonDocumentRequest) =>
      postInference('rerankText', request),
    summarizeText: (request: OracleOciJsonDocumentRequest) =>
      postInference('summarizeText', request),
    listModels,
    listEndpoints,
    getWorkRequest: (request: OracleOciWorkRequestRequest) =>
      observeWorkRequest(request, ''),
    listWorkRequestErrors: (request: OracleOciWorkRequestCollectionRequest) =>
      observeWorkRequest(request, '/errors'),
    listWorkRequestLogs: (request: OracleOciWorkRequestCollectionRequest) =>
      observeWorkRequest(request, '/logs'),
  });
}
