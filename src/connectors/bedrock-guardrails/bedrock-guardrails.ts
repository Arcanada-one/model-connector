import {
  BedrockGuardrailsError,
  type BedrockGuardrailOperation,
  type BedrockGuardrailsConfig,
  type BedrockGuardrailsSigner,
  type BedrockGuardrailsTransport,
  type BedrockGuardrailsTransportResponse,
} from './types';
import {
  cloneSafeJson,
  exactKeys,
  isPlainRecord,
  normalizeApplyBody,
  normalizeGuardrailBody,
  record,
  validateIdentifier,
  validateRegion,
  validateVersion,
} from './validation';

export * from './types';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const STATUSES = new Set(['CREATING', 'UPDATING', 'VERSIONING', 'READY', 'FAILED', 'DELETING']);
const SIGNED_HEADER_ALLOWLIST = new Set([
  'authorization',
  'x-amz-date',
  'x-amz-security-token',
  'x-amz-content-sha256',
]);

interface RequestShape {
  operation: BedrockGuardrailOperation;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  plane: 'control' | 'runtime';
  path: string;
  body?: Record<string, unknown>;
  expectedStatus: number;
  response: 'create' | 'createVersion' | 'get' | 'list' | 'update' | 'delete' | 'apply';
}

function config(input: unknown): {
  region: string;
  signer: BedrockGuardrailsSigner;
  transport: BedrockGuardrailsTransport;
  timeoutMs: number;
} {
  const value = record(input, 'invalid_config', 'Bedrock Guardrails config');
  exactKeys(value, ['region', 'signer', 'transport', 'timeoutMs'], 'invalid_config', 'Bedrock Guardrails config');
  if (typeof value.signer !== 'function' || typeof value.transport !== 'function') {
    throw new BedrockGuardrailsError('invalid_config', 'Signer and transport are required');
  }
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : value.timeoutMs;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300_000) {
    throw new BedrockGuardrailsError('invalid_config', 'Timeout is invalid');
  }
  return {
    region: validateRegion(value.region),
    signer: value.signer as BedrockGuardrailsSigner,
    transport: value.transport as BedrockGuardrailsTransport,
    timeoutMs: timeoutMs as number,
  };
}

function optionalString(value: unknown, min: number, max: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < min || value.length > max || /\s/.test(value)) {
    throw new BedrockGuardrailsError('invalid_request', `${label} is invalid`);
  }
  return value;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === target) return value;
  return undefined;
}

function validateSignedHeaders(input: unknown): Record<string, string> {
  if (!isPlainRecord(input)) throw new BedrockGuardrailsError('signing_error', 'Signer returned invalid headers');
  const output: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (seen.has(lower) || !SIGNED_HEADER_ALLOWLIST.has(lower) || typeof value !== 'string' || value.length === 0 || value.length > 8192 || /[\r\n]/.test(value)) {
      throw new BedrockGuardrailsError('signing_error', 'Signer returned invalid headers');
    }
    seen.add(lower);
    output[name] = value;
  }
  if (!headerValue(output, 'authorization')) throw new BedrockGuardrailsError('signing_error', 'Signer omitted authorization');
  return output;
}

function validateTransportResponse(input: unknown): BedrockGuardrailsTransportResponse {
  const value = record(input, 'invalid_response', 'Transport response');
  exactKeys(value, ['status', 'headers', 'body'], 'invalid_response', 'Transport response');
  if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599 || typeof value.body !== 'string' || !isPlainRecord(value.headers)) {
    throw new BedrockGuardrailsError('invalid_response', 'Transport response is malformed');
  }
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value.headers)) {
    if (typeof header !== 'string' || name.length > 256 || header.length > 8192 || /[\r\n]/.test(name)) throw new BedrockGuardrailsError('invalid_response', 'Transport response headers are malformed');
    headers[name] = header;
  }
  return { status: value.status as number, headers, body: value.body };
}

function safeProviderCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.split(/[#/:]/).pop() ?? '';
  return /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code) ? code : undefined;
}

function requestId(headers: Record<string, string>): string | undefined {
  const value = headerValue(headers, 'x-amzn-requestid') ?? headerValue(headers, 'x-amz-request-id');
  return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function providerError(response: BedrockGuardrailsTransportResponse): BedrockGuardrailsError {
  let body: Record<string, unknown> = {};
  if (Buffer.byteLength(response.body, 'utf8') <= MAX_RESPONSE_BYTES) {
    try {
      const parsed = JSON.parse(response.body) as unknown;
      if (isPlainRecord(parsed)) body = parsed;
    } catch {
      // Error bodies are deliberately optional and never forwarded.
    }
  }
  const providerCode = safeProviderCode(headerValue(response.headers, 'x-amzn-errortype')) ??
    safeProviderCode(body.__type) ?? safeProviderCode(body.code) ?? safeProviderCode(body.type);
  return new BedrockGuardrailsError('provider_error', 'Bedrock Guardrails request failed', {
    status: response.status,
    providerCode,
    requestId: requestId(response.headers),
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
  });
}

function parseJson(body: string): Record<string, unknown> {
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new BedrockGuardrailsError('response_too_large', 'Provider response exceeds the local safety ceiling');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new BedrockGuardrailsError('invalid_response', 'Provider response is not valid JSON');
  }
  try {
    const cloned = cloneSafeJson(parsed, 'Provider response');
    return record(cloned, 'invalid_response', 'Provider response');
  } catch (error) {
    if (error instanceof BedrockGuardrailsError) throw new BedrockGuardrailsError('invalid_response', 'Provider response is structurally invalid');
    throw error;
  }
}

function requiredString(value: unknown, pattern: RegExp | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || (pattern && !pattern.test(value))) {
    throw new BedrockGuardrailsError('invalid_response', `${label} is invalid`);
  }
  return value;
}

function parseResponse(kind: RequestShape['response'], body: string): unknown {
  if (kind === 'delete') {
    if (body !== '') throw new BedrockGuardrailsError('invalid_response', 'DeleteGuardrail response body must be empty');
    return undefined;
  }
  const value = parseJson(body);
  if (kind === 'create') {
    exactKeys(value, ['createdAt', 'guardrailArn', 'guardrailId', 'version'], 'invalid_response', 'CreateGuardrail response');
    requiredString(value.createdAt, undefined, 'createdAt');
    requiredString(value.guardrailArn, /^arn:/, 'guardrailArn');
    requiredString(value.guardrailId, /^[a-z0-9]+$/, 'guardrailId');
    if (value.version !== 'DRAFT') throw new BedrockGuardrailsError('invalid_response', 'CreateGuardrail version is invalid');
  } else if (kind === 'createVersion') {
    exactKeys(value, ['guardrailId', 'version'], 'invalid_response', 'CreateGuardrailVersion response');
    requiredString(value.guardrailId, /^[a-z0-9]+$/, 'guardrailId');
    requiredString(value.version, /^[1-9][0-9]{0,7}$/, 'version');
  } else if (kind === 'update') {
    exactKeys(value, ['guardrailArn', 'guardrailId', 'updatedAt', 'version'], 'invalid_response', 'UpdateGuardrail response');
    requiredString(value.guardrailArn, /^arn:/, 'guardrailArn');
    requiredString(value.guardrailId, /^[a-z0-9]+$/, 'guardrailId');
    requiredString(value.updatedAt, undefined, 'updatedAt');
    if (value.version !== 'DRAFT') throw new BedrockGuardrailsError('invalid_response', 'UpdateGuardrail version is invalid');
  } else if (kind === 'get') {
    exactKeys(value, [
      'automatedReasoningPolicy', 'blockedInputMessaging', 'blockedOutputsMessaging',
      'contentPolicy', 'contextualGroundingPolicy', 'createdAt', 'crossRegionDetails',
      'description', 'failureRecommendations', 'guardrailArn', 'guardrailId', 'kmsKeyArn',
      'name', 'sensitiveInformationPolicy', 'status', 'statusReasons', 'topicPolicy',
      'updatedAt', 'version', 'wordPolicy',
    ], 'invalid_response', 'GetGuardrail response');
    for (const field of ['blockedInputMessaging', 'blockedOutputsMessaging', 'createdAt', 'guardrailArn', 'guardrailId', 'name', 'updatedAt', 'version']) requiredString(value[field], undefined, field);
    if (!STATUSES.has(String(value.status)) || !/^(?:DRAFT|[1-9][0-9]{0,7})$/.test(String(value.version))) throw new BedrockGuardrailsError('invalid_response', 'GetGuardrail status or version is invalid');
  } else if (kind === 'list') {
    exactKeys(value, ['guardrails', 'nextToken'], 'invalid_response', 'ListGuardrails response');
    if (!Array.isArray(value.guardrails) || value.guardrails.length > 1000) throw new BedrockGuardrailsError('invalid_response', 'Guardrail summaries are invalid');
    for (const summaryValue of value.guardrails) {
      const summary = record(summaryValue, 'invalid_response', 'Guardrail summary');
      exactKeys(summary, ['arn', 'createdAt', 'crossRegionDetails', 'description', 'id', 'name', 'status', 'updatedAt', 'version'], 'invalid_response', 'Guardrail summary');
      for (const field of ['arn', 'createdAt', 'id', 'name', 'updatedAt', 'version']) requiredString(summary[field], undefined, field);
      if (!STATUSES.has(String(summary.status)) || !/^(?:DRAFT|[1-9][0-9]{0,7})$/.test(String(summary.version))) throw new BedrockGuardrailsError('invalid_response', 'Guardrail summary status or version is invalid');
    }
    if (value.nextToken !== undefined && (typeof value.nextToken !== 'string' || value.nextToken.length < 1 || value.nextToken.length > 2048 || /\s/.test(value.nextToken))) throw new BedrockGuardrailsError('invalid_response', 'Pagination token is invalid');
  } else if (kind === 'apply') {
    exactKeys(value, ['action', 'actionReason', 'assessments', 'guardrailCoverage', 'outputs', 'usage'], 'invalid_response', 'ApplyGuardrail response');
    if (value.action !== 'NONE' && value.action !== 'GUARDRAIL_INTERVENED') throw new BedrockGuardrailsError('invalid_response', 'Apply action is invalid');
    if (!Array.isArray(value.assessments) || !Array.isArray(value.outputs) || !isPlainRecord(value.usage)) throw new BedrockGuardrailsError('invalid_response', 'Apply response is malformed');
  }
  return value;
}

export class BedrockGuardrailsClient {
  private readonly region: string;
  private readonly signer: BedrockGuardrailsSigner;
  private readonly transport: BedrockGuardrailsTransport;
  private readonly timeoutMs: number;

  constructor(input: BedrockGuardrailsConfig) {
    const normalized = config(input);
    this.region = normalized.region;
    this.signer = normalized.signer;
    this.transport = normalized.transport;
    this.timeoutMs = normalized.timeoutMs;
  }

  async createGuardrail(input: unknown): Promise<unknown> {
    const { body } = normalizeGuardrailBody(input, false);
    return this.send({ operation: 'CreateGuardrail', method: 'POST', plane: 'control', path: '/guardrails', body, expectedStatus: 202, response: 'create' });
  }

  async createGuardrailVersion(input: unknown): Promise<unknown> {
    const value = record(input, 'invalid_request', 'CreateGuardrailVersion input');
    exactKeys(value, ['guardrailIdentifier', 'clientRequestToken', 'description'], 'invalid_request', 'CreateGuardrailVersion input');
    const identifier = validateIdentifier(value.guardrailIdentifier);
    const body: Record<string, unknown> = {};
    if (value.clientRequestToken !== undefined) body.clientRequestToken = this.requestString(value.clientRequestToken, 1, 256, 'Client request token');
    if (value.description !== undefined) body.description = this.requestString(value.description, 1, 200, 'Description');
    return this.send({ operation: 'CreateGuardrailVersion', method: 'POST', plane: 'control', path: `/guardrails/${encodeURIComponent(identifier)}`, body, expectedStatus: 202, response: 'createVersion' });
  }

  async getGuardrail(input: unknown): Promise<unknown> {
    const value = record(input, 'invalid_request', 'GetGuardrail input');
    exactKeys(value, ['guardrailIdentifier', 'guardrailVersion'], 'invalid_request', 'GetGuardrail input');
    const identifier = validateIdentifier(value.guardrailIdentifier);
    const version = value.guardrailVersion === undefined ? undefined : validateVersion(value.guardrailVersion);
    return this.send({ operation: 'GetGuardrail', method: 'GET', plane: 'control', path: `/guardrails/${encodeURIComponent(identifier)}${version ? `?guardrailVersion=${encodeURIComponent(version)}` : ''}`, expectedStatus: 200, response: 'get' });
  }

  async listGuardrails(input: unknown): Promise<unknown> {
    const value = record(input, 'invalid_request', 'ListGuardrails input');
    exactKeys(value, ['guardrailIdentifier', 'maxResults', 'nextToken'], 'invalid_request', 'ListGuardrails input');
    const pairs: Array<[string, string]> = [];
    if (value.guardrailIdentifier !== undefined) pairs.push(['guardrailIdentifier', validateIdentifier(value.guardrailIdentifier)]);
    if (value.maxResults !== undefined) {
      if (!Number.isInteger(value.maxResults) || (value.maxResults as number) < 1 || (value.maxResults as number) > 1000) throw new BedrockGuardrailsError('invalid_request', 'maxResults is invalid');
      pairs.push(['maxResults', String(value.maxResults)]);
    }
    const token = optionalString(value.nextToken, 1, 2048, 'nextToken');
    if (token !== undefined) pairs.push(['nextToken', token]);
    const query = pairs.length ? `?${pairs.map(([key, entry]) => `${key}=${encodeURIComponent(entry)}`).join('&')}` : '';
    return this.send({ operation: 'ListGuardrails', method: 'GET', plane: 'control', path: `/guardrails${query}`, expectedStatus: 200, response: 'list' });
  }

  async updateGuardrail(input: unknown): Promise<unknown> {
    const { identifier, body } = normalizeGuardrailBody(input, true);
    return this.send({ operation: 'UpdateGuardrail', method: 'PUT', plane: 'control', path: `/guardrails/${encodeURIComponent(identifier!)}`, body, expectedStatus: 202, response: 'update' });
  }

  async deleteGuardrail(input: unknown): Promise<void> {
    const value = record(input, 'invalid_request', 'DeleteGuardrail input');
    exactKeys(value, ['guardrailIdentifier', 'guardrailVersion'], 'invalid_request', 'DeleteGuardrail input');
    const identifier = validateIdentifier(value.guardrailIdentifier);
    const version = value.guardrailVersion === undefined ? undefined : validateVersion(value.guardrailVersion, false);
    await this.send({ operation: 'DeleteGuardrail', method: 'DELETE', plane: 'control', path: `/guardrails/${encodeURIComponent(identifier)}${version ? `?guardrailVersion=${version}` : ''}`, expectedStatus: 202, response: 'delete' });
  }

  async applyGuardrail(input: unknown): Promise<unknown> {
    const { identifier, version, body } = normalizeApplyBody(input);
    return this.send({ operation: 'ApplyGuardrail', method: 'POST', plane: 'runtime', path: `/guardrail/${encodeURIComponent(identifier)}/version/${encodeURIComponent(version)}/apply`, body, expectedStatus: 200, response: 'apply' });
  }

  private requestString(value: unknown, min: number, max: number, label: string): string {
    if (typeof value !== 'string' || value.length < min || value.length > max || /[\r\n]/.test(value)) throw new BedrockGuardrailsError('invalid_request', `${label} is invalid`);
    return value;
  }

  private async send(shape: RequestShape): Promise<unknown> {
    const host = shape.plane === 'control' ? `https://bedrock.${this.region}.amazonaws.com` : `https://bedrock-runtime.${this.region}.amazonaws.com`;
    const url = `${host}${shape.path}`;
    const body = shape.body === undefined ? undefined : JSON.stringify(shape.body);
    const headers: Record<string, string> =
      body === undefined ? {} : { 'Content-Type': 'application/json' };
    let signed: Record<string, string>;
    try {
      signed = validateSignedHeaders(await this.signer({ operation: shape.operation, region: this.region, service: 'bedrock', method: shape.method, url, headers, ...(body === undefined ? {} : { body }) }));
    } catch (error) {
      if (error instanceof BedrockGuardrailsError) throw error;
      throw new BedrockGuardrailsError('signing_error', 'Bedrock request signing failed');
    }
    let raw: unknown;
    try {
      raw = await this.transport(url, { method: shape.method, headers: { ...headers, ...signed }, ...(body === undefined ? {} : { body }), redirect: 'manual', timeoutMs: this.timeoutMs });
    } catch {
      throw new BedrockGuardrailsError('transport_error', 'Bedrock transport failed', { retryable: true });
    }
    const response = validateTransportResponse(raw);
    if (response.status !== shape.expectedStatus) {
      if (response.status >= 200 && response.status < 300) {
        throw new BedrockGuardrailsError('unexpected_status', 'Bedrock returned an unexpected success status', { status: response.status });
      }
      throw providerError(response);
    }
    return parseResponse(shape.response, response.body);
  }
}
