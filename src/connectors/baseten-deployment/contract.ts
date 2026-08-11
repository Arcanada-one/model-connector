const INVALID_INPUT = 'BASETEN_DEPLOYMENT_INVALID_INPUT';
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MODEL_ID_PATTERN = /^[a-zA-Z0-9]{1,64}$/;

const SYNC_REQUIRED_KEYS = [
  'apiVersion',
  'operation',
  'hostingMode',
  'modelId',
  'target',
  'authorizationScheme',
  'payload',
] as const;

const ASYNC_REQUIRED_KEYS = [
  'apiVersion',
  'operation',
  'hostingMode',
  'modelId',
  'target',
  'authorizationScheme',
  'model_input',
] as const;

const ASYNC_OPTIONAL_KEYS = [
  'priority',
  'max_time_in_queue_seconds',
  'inference_retry_config',
] as const;

function invalid(): never {
  throw new Error(INVALID_INPUT);
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

export const BASETEN_DEPLOYMENT_LIMITS = freezeDeep({
  maxDepth: 8,
  maxKeysPerObject: 32,
  maxArrayLength: 128,
  maxStringBytes: 262_144,
  maxAggregateInputBytes: 1_048_576,
  maxAsyncSerializedBodyBytes: 262_144,
  maxResponseBytes: 4_194_304,
});

export const BASETEN_DEPLOYMENT_INFERENCE_CONTRACT = freezeDeep({
  provider: 'baseten-deployment',
  service: 'baseten-dedicated-model-deployment-inference',
  apiVersion: 'inference-v1',
  operations: ['deployment.predict.sync', 'deployment.predict.async_submit'],
  resourceKind: 'model',
  authorizationSchemes: ['Bearer', 'Api-Key'],
  authorizationOwner: 'caller',
  retryCount: 0,
});

interface InspectionState {
  readonly active: WeakSet<object>;
  readonly maxAggregateBytes: number;
  aggregateBytes: number;
}

function addBytes(state: InspectionState, value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > BASETEN_DEPLOYMENT_LIMITS.maxStringBytes) invalid();
  state.aggregateBytes += bytes;
  if (state.aggregateBytes > state.maxAggregateBytes) invalid();
}

function inspectSafeValue(value: unknown, maxAggregateBytes: number): void {
  const state: InspectionState = {
    active: new WeakSet<object>(),
    maxAggregateBytes,
    aggregateBytes: 0,
  };
  inspectValue(value, 0, state);
}

function inspectValue(value: unknown, depth: number, state: InspectionState): void {
  if (depth > BASETEN_DEPLOYMENT_LIMITS.maxDepth) invalid();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    addBytes(state, value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return;
  }
  if (typeof value !== 'object') invalid();
  if (state.active.has(value)) invalid();

  state.active.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === 'symbol')) invalid();

    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set) invalid();
    }

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) invalid();
      if (value.length > BASETEN_DEPLOYMENT_LIMITS.maxArrayLength) invalid();
      const descriptorKeys = Object.keys(descriptors);
      const elementKeys = descriptorKeys.filter((key) => key !== 'length');
      if (
        descriptorKeys.length !== value.length + 1 ||
        elementKeys.length !== value.length ||
        elementKeys.some((key, index) => key !== String(index))
      ) {
        invalid();
      }
      for (const key of elementKeys) {
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor)) invalid();
        inspectValue(descriptor.value, depth + 1, state);
      }
      return;
    }

    if (prototype !== Object.prototype && prototype !== null) invalid();
    const recordKeys = Object.keys(descriptors);
    if (recordKeys.length > BASETEN_DEPLOYMENT_LIMITS.maxKeysPerObject) invalid();
    for (const key of recordKeys) {
      if (POLLUTION_KEYS.has(key)) invalid();
      addBytes(state, key);
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) invalid();
      inspectValue(descriptor.value, depth + 1, state);
    }
  } catch {
    invalid();
  } finally {
    state.active.delete(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!hasOwn(record, key)) invalid();
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid();
  }
}

function asBoundedString(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string') invalid();
  if (!allowEmpty && value.length === 0) invalid();
  if (Buffer.byteLength(value, 'utf8') > BASETEN_DEPLOYMENT_LIMITS.maxStringBytes) invalid();
  return value;
}

function asInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    invalid();
  }
  return value;
}

function parseIdentifier(value: unknown): string {
  const identifier = asBoundedString(value);
  if (!IDENTIFIER_PATTERN.test(identifier)) invalid();
  return identifier;
}

function parseModelId(value: unknown): string {
  const modelId = asBoundedString(value);
  if (!MODEL_ID_PATTERN.test(modelId)) invalid();
  return modelId;
}

type HostingMode = 'non_regional' | 'regional';
type AuthorizationScheme = 'Bearer' | 'Api-Key';
type Operation = 'deployment.predict.sync' | 'deployment.predict.async_submit';

interface ParsedTarget {
  hostingMode: HostingMode;
  pathSegment: string;
  regionalEnvironmentName?: string;
}

function parseHostingMode(value: unknown): HostingMode {
  if (value !== 'non_regional' && value !== 'regional') invalid();
  return value;
}

function parseAuthorizationScheme(value: unknown): AuthorizationScheme {
  if (value !== 'Bearer' && value !== 'Api-Key') invalid();
  return value;
}

function parseOperation(value: unknown): Operation {
  if (value !== 'deployment.predict.sync' && value !== 'deployment.predict.async_submit') {
    invalid();
  }
  return value;
}

function parseTarget(hostingMode: HostingMode, value: unknown): ParsedTarget {
  const target = asRecord(value);
  const kind = target.kind;
  if (typeof kind !== 'string') invalid();

  if (hostingMode === 'regional') {
    assertExactKeys(target, ['kind', 'environmentName']);
    if (kind !== 'regional') invalid();
    const environmentName = parseIdentifier(target.environmentName);
    return {
      hostingMode,
      pathSegment: '',
      regionalEnvironmentName: environmentName,
    };
  }

  if (kind === 'production') {
    assertExactKeys(target, ['kind']);
    return { hostingMode, pathSegment: 'production' };
  }
  if (kind === 'development') {
    assertExactKeys(target, ['kind']);
    return { hostingMode, pathSegment: 'development' };
  }
  if (kind === 'environment') {
    assertExactKeys(target, ['kind', 'name']);
    const name = parseIdentifier(target.name);
    return { hostingMode, pathSegment: `environments/${name}` };
  }
  if (kind === 'deployment') {
    assertExactKeys(target, ['kind', 'deploymentId']);
    const deploymentId = parseIdentifier(target.deploymentId);
    return { hostingMode, pathSegment: `deployment/${deploymentId}` };
  }
  invalid();
}

function endpointForOperation(operation: Operation): string {
  return operation === 'deployment.predict.sync' ? 'predict' : 'async_predict';
}

function buildUrl(modelId: string, target: ParsedTarget, operation: Operation): string {
  const endpoint = endpointForOperation(operation);
  if (target.hostingMode === 'regional') {
    if (!target.regionalEnvironmentName) invalid();
    return `https://model-${modelId}-${target.regionalEnvironmentName}.api.baseten.co/${endpoint}`;
  }
  return `https://model-${modelId}.api.baseten.co/${target.pathSegment}/${endpoint}`;
}

function copySafeRecord(value: unknown): Record<string, unknown> {
  inspectSafeValue(value, BASETEN_DEPLOYMENT_LIMITS.maxAggregateInputBytes);
  const record = asRecord(value);
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (POLLUTION_KEYS.has(key)) invalid();
    copy[key] = copySafeValue(record[key]);
  }
  return copy;
}

function copySafeValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) invalid();
    return value;
  }
  if (typeof value === 'string') {
    return asBoundedString(value, true);
  }
  if (Array.isArray(value)) {
    if (value.length > BASETEN_DEPLOYMENT_LIMITS.maxArrayLength) invalid();
    return value.map((item) => copySafeValue(item));
  }
  return copySafeRecord(value);
}

function parseInferenceRetryConfig(value: unknown): Record<string, unknown> {
  const config = asRecord(value);
  assertExactKeys(config, ['max_attempts', 'initial_delay_ms', 'max_delay_ms']);
  return {
    max_attempts: asInteger(config.max_attempts, 1, 10),
    initial_delay_ms: asInteger(config.initial_delay_ms, 0, 10_000),
    max_delay_ms: asInteger(config.max_delay_ms, 0, 60_000),
  };
}

export interface BasetenDeploymentRequestDescriptor {
  provider: 'baseten-deployment';
  method: 'POST';
  url: string;
  headers: {
    'Content-Type': 'application/json';
  };
  authorization: {
    scheme: AuthorizationScheme;
    owner: 'caller';
  };
  retryCount: 0;
  body: Record<string, unknown>;
}

export function buildBasetenDeploymentRequest(input: unknown): BasetenDeploymentRequestDescriptor {
  inspectSafeValue(input, BASETEN_DEPLOYMENT_LIMITS.maxAggregateInputBytes);
  const record = asRecord(input);

  if (record.apiVersion !== BASETEN_DEPLOYMENT_INFERENCE_CONTRACT.apiVersion) invalid();
  const operation = parseOperation(record.operation);
  const hostingMode = parseHostingMode(record.hostingMode);
  const modelId = parseModelId(record.modelId);
  const target = parseTarget(hostingMode, record.target);
  const authorizationScheme = parseAuthorizationScheme(record.authorizationScheme);

  let body: Record<string, unknown>;
  if (operation === 'deployment.predict.sync') {
    assertExactKeys(record, [...SYNC_REQUIRED_KEYS]);
    body = copySafeRecord(record.payload);
  } else {
    assertExactKeys(record, [...ASYNC_REQUIRED_KEYS], [...ASYNC_OPTIONAL_KEYS]);
    body = {
      model_input: copySafeRecord(record.model_input),
    };
    if (hasOwn(record, 'priority')) {
      body.priority = asInteger(record.priority, 0, 2);
    }
    if (hasOwn(record, 'max_time_in_queue_seconds')) {
      body.max_time_in_queue_seconds = asInteger(record.max_time_in_queue_seconds, 10, 259_200);
    }
    if (hasOwn(record, 'inference_retry_config')) {
      body.inference_retry_config = parseInferenceRetryConfig(record.inference_retry_config);
    }
    const serializedBodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (serializedBodyBytes > BASETEN_DEPLOYMENT_LIMITS.maxAsyncSerializedBodyBytes) {
      invalid();
    }
  }

  return freezeDeep({
    provider: 'baseten-deployment',
    method: 'POST',
    url: buildUrl(modelId, target, operation),
    headers: {
      'Content-Type': 'application/json',
    },
    authorization: {
      scheme: authorizationScheme,
      owner: 'caller',
    },
    retryCount: 0,
    body,
  });
}

export function parseBasetenDeploymentSyncResponse(input: unknown): Record<string, unknown> {
  inspectSafeValue(input, BASETEN_DEPLOYMENT_LIMITS.maxResponseBytes);
  return freezeDeep(copySafeRecord(input));
}

export function parseBasetenDeploymentAsyncSubmitResponse(
  input: unknown,
): { request_id: string } {
  inspectSafeValue(input, BASETEN_DEPLOYMENT_LIMITS.maxResponseBytes);
  const record = asRecord(input);
  assertExactKeys(record, ['request_id']);
  return freezeDeep({
    request_id: asBoundedString(record.request_id),
  });
}

export type BasetenDeploymentFailureCode =
  | 'unauthorized'
  | 'payload_too_large'
  | 'invalid_request'
  | 'rate_limited'
  | 'internal_error'
  | 'bad_gateway'
  | 'unavailable'
  | 'gateway_timeout'
  | 'upstream_error'
  | 'timeout';

export interface BasetenDeploymentFailure {
  provider: 'baseten-deployment';
  code: BasetenDeploymentFailureCode;
  status?: number;
  retry: false;
}

const HTTP_FAILURE_CODES: Readonly<Record<number, BasetenDeploymentFailureCode>> = freezeDeep({
  401: 'unauthorized',
  413: 'payload_too_large',
  422: 'invalid_request',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'bad_gateway',
  503: 'unavailable',
  504: 'gateway_timeout',
});

export function classifyBasetenDeploymentFailure(input: unknown): BasetenDeploymentFailure {
  inspectSafeValue(input, 1_024);
  const record = asRecord(input);
  if (record.kind === 'timeout') {
    assertExactKeys(record, ['kind']);
    return freezeDeep({
      provider: 'baseten-deployment',
      code: 'timeout',
      retry: false,
    });
  }
  if (record.kind !== 'http') invalid();
  assertExactKeys(record, ['kind', 'status']);
  const status = asInteger(record.status, 400, 599);
  return freezeDeep({
    provider: 'baseten-deployment',
    code: HTTP_FAILURE_CODES[status] ?? 'upstream_error',
    status,
    retry: false,
  });
}
