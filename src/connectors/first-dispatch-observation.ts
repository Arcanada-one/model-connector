import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import type { FirstDispatchMeasurementV0 } from './dto/execute.dto';
import type { ConnectorRequest, ConnectorResponse } from './interfaces/connector.interface';

export const FIRST_DISPATCH_OBSERVATION_VERSION = 'first-dispatch-observation/v0' as const;
export const MODEL_CONNECTOR_OBSERVATION_BOUNDARY =
  'model-connector/service/pre-adapter-v0' as const;

export interface FirstDispatchReservationV0 {
  observationId: string;
  observationKeySha256: string;
  measurement: FirstDispatchMeasurementV0;
  connector: string;
  requestedModel: string | null;
  requestPayloadDigestSha256: string;
  requestPayloadBytes: number;
  observationBoundary: typeof MODEL_CONNECTOR_OBSERVATION_BOUNDARY;
}

export interface FirstDispatchObservationV0 {
  version: typeof FIRST_DISPATCH_OBSERVATION_VERSION;
  observationId: string;
  measurement: FirstDispatchMeasurementV0;
  connector: string;
  model: string;
  connectorResponseId: string;
  requestPayloadDigestSha256: string;
  requestPayloadBytes: number;
  observationBoundary: typeof MODEL_CONNECTOR_OBSERVATION_BOUNDARY;
  usage: {
    inputTokens: number;
    cachedInputTokens: null;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    source: 'CONNECTOR_RESPONSE_UNVERIFIED';
  };
  latencyMs: number;
  outcome: ConnectorResponse['status'];
  persistence: 'MODEL_CONNECTOR_POSTGRESQL';
  evidenceStatus: 'PERSISTED_PRE_ADAPTER_OBSERVATION';
  authorization: 'NOT_AUTHORIZED';
  receiptDigestSha256: string;
}

export function reserveFirstDispatchObservationV0(input: {
  observationId: string;
  apiKeyId: string;
  measurement: FirstDispatchMeasurementV0;
  connector: string;
  providerRequest: ConnectorRequest;
}): FirstDispatchReservationV0 {
  const requestPayload = canonicalJson(input.providerRequest);
  const requestPayloadDigestSha256 = sha256(requestPayload);
  const principalBindingDigestSha256 = sha256(input.apiKeyId);
  const requestedModel = input.providerRequest.model ?? null;
  const observationKeySha256 = sha256(
    canonicalJson({
      version: FIRST_DISPATCH_OBSERVATION_VERSION,
      principalBindingDigestSha256,
      measurement: input.measurement,
      connector: input.connector,
      requestedModel,
      observationBoundary: MODEL_CONNECTOR_OBSERVATION_BOUNDARY,
    }),
  );

  return {
    observationId: input.observationId,
    observationKeySha256,
    measurement: { ...input.measurement },
    connector: input.connector,
    requestedModel,
    requestPayloadDigestSha256,
    requestPayloadBytes: Buffer.byteLength(requestPayload, 'utf8'),
    observationBoundary: MODEL_CONNECTOR_OBSERVATION_BOUNDARY,
  };
}

export function finalizeFirstDispatchObservationV0(
  reservation: FirstDispatchReservationV0,
  response: ConnectorResponse,
): FirstDispatchObservationV0 {
  const receiptWithoutDigest = {
    version: FIRST_DISPATCH_OBSERVATION_VERSION,
    observationId: reservation.observationId,
    measurement: { ...reservation.measurement },
    connector: response.connector,
    model: response.model,
    connectorResponseId: response.id,
    requestPayloadDigestSha256: reservation.requestPayloadDigestSha256,
    requestPayloadBytes: reservation.requestPayloadBytes,
    observationBoundary: reservation.observationBoundary,
    usage: {
      inputTokens: response.usage.inputTokens,
      cachedInputTokens: null,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      costUsd: response.usage.costUsd,
      source: 'CONNECTOR_RESPONSE_UNVERIFIED' as const,
    },
    latencyMs: response.latencyMs,
    outcome: response.status,
    persistence: 'MODEL_CONNECTOR_POSTGRESQL' as const,
    evidenceStatus: 'PERSISTED_PRE_ADAPTER_OBSERVATION' as const,
    authorization: 'NOT_AUTHORIZED' as const,
  };

  return {
    ...receiptWithoutDigest,
    receiptDigestSha256: sha256(canonicalJson(receiptWithoutDigest)),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number in canonical JSON');
    return value;
  }
  if (typeof value === 'object') {
    if (utilTypes.isProxy(value)) {
      throw new TypeError('proxy in canonical JSON');
    }
    if (Array.isArray(value)) {
      return normalizeArray(value);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('non-plain object in canonical JSON');
    }
    const normalized = Object.create(null) as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === 'symbol') throw new TypeError('symbol key in canonical JSON');
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) throw new TypeError('non-enumerable property in canonical JSON');
      if (!('value' in descriptor)) throw new TypeError('accessor property in canonical JSON');
    }
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (descriptor.value !== undefined) normalized[key] = normalize(descriptor.value);
    }
    return normalized;
  }
  throw new TypeError('unsupported value in canonical JSON');
}

function normalizeArray(value: unknown[]): unknown[] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new TypeError('symbol key in canonical JSON');
  }
  const stringKeys = ownKeys.filter((key): key is string => typeof key === 'string');
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  const dataKeys = stringKeys
    .filter((key) => key !== 'length')
    .sort((left, right) => {
      return Number(left) - Number(right);
    });
  if (
    dataKeys.length !== expectedKeys.length ||
    dataKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError('sparse or extended array in canonical JSON');
  }
  return expectedKeys.map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('non-data array element in canonical JSON');
    }
    return normalize(descriptor.value);
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
