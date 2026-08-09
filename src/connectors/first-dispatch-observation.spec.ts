import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import type { FirstDispatchMeasurementV0 } from './dto/execute.dto';
import {
  canonicalJson,
  finalizeFirstDispatchObservationV0,
  reserveFirstDispatchObservationV0,
} from './first-dispatch-observation';
import type { ConnectorResponse } from './interfaces/connector.interface';

const measurement: FirstDispatchMeasurementV0 = {
  version: 'first-dispatch-measurement/v0',
  corpusId: 'corpus-v0',
  caseId: 'case-007',
  roleId: 'developer',
  taskClassId: 'code-change',
  commandId: 'implement',
  replayIndex: 1,
  variant: 'baseline',
  adapterBoundary: 'arcana-agent-system/driver/first-dispatch-v0',
};

const response: ConnectorResponse = {
  id: 'provider-response-1',
  connector: 'test',
  model: 'model-a',
  result: 'private provider output',
  usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.0000123 },
  latencyMs: 50,
  status: 'success',
};

function reservation() {
  return reserveFirstDispatchObservationV0({
    observationId: '00000000-0000-4000-8000-000000000001',
    apiKeyId: 'private-api-key-id',
    measurement,
    connector: 'test',
    providerRequest: {
      prompt: 'private prompt',
      model: 'model-a',
      systemPrompt: 'private system prompt',
    },
  });
}

describe('first-dispatch observation', () => {
  it('canonicalizes object key order deterministically', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('binds the complete pre-adapter request without returning prompt content', () => {
    const reserved = reservation();
    const observation = finalizeFirstDispatchObservationV0(reserved, response);

    expect(reserved.requestPayloadDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reserved.requestPayloadBytes).toBeGreaterThan(Buffer.byteLength('private prompt'));
    expect(JSON.stringify(observation)).not.toContain('private prompt');
    expect(JSON.stringify(observation)).not.toContain('private system prompt');
    expect(JSON.stringify(observation)).not.toContain('private provider output');
    expect(JSON.stringify(observation)).not.toContain('private-api-key-id');
  });

  it('reserves one logical attempt even when its payload is changed', () => {
    const original = reservation();
    const changedPayload = reserveFirstDispatchObservationV0({
      observationId: '00000000-0000-4000-8000-000000000002',
      apiKeyId: 'private-api-key-id',
      measurement,
      connector: 'test',
      providerRequest: {
        prompt: 'different private prompt',
        model: 'model-a',
        systemPrompt: 'private system prompt',
      },
    });

    expect(changedPayload.requestPayloadDigestSha256).not.toBe(original.requestPayloadDigestSha256);
    expect(changedPayload.observationKeySha256).toBe(original.observationKeySha256);
  });

  it('changes the receipt digest when model identity, usage, or raw parity outcome changes', () => {
    const reserved = reservation();
    const original = finalizeFirstDispatchObservationV0(reserved, response);
    const changedModel = finalizeFirstDispatchObservationV0(reserved, {
      ...response,
      model: 'model-b',
    });
    const changedUsage = finalizeFirstDispatchObservationV0(reserved, {
      ...response,
      usage: { ...response.usage, inputTokens: 11, totalTokens: 13 },
    });
    const changedOutcome = finalizeFirstDispatchObservationV0(reserved, {
      ...response,
      status: 'error',
    });

    expect(changedModel.receiptDigestSha256).not.toBe(original.receiptDigestSha256);
    expect(changedUsage.receiptDigestSha256).not.toBe(original.receiptDigestSha256);
    expect(changedOutcome.receiptDigestSha256).not.toBe(original.receiptDigestSha256);
  });

  it('stores a lossless receipt preimage for independent digest reconstruction', () => {
    const observation = finalizeFirstDispatchObservationV0(reservation(), response);
    const { receiptDigestSha256, ...preimage } = observation;
    const reconstructed = createHash('sha256')
      .update(canonicalJson(preimage), 'utf8')
      .digest('hex');

    expect(observation.usage.costUsd).toBe(0.0000123);
    expect(reconstructed).toBe(receiptDigestSha256);
  });

  it('rejects non-plain and non-finite canonical values', () => {
    expect(() => canonicalJson(new Date())).toThrow('non-plain object');
    expect(() => canonicalJson({ value: Number.NaN })).toThrow('non-finite number');
  });

  it('binds an own __proto__ JSON key instead of eliding it', () => {
    const withProtoKey = { extra: JSON.parse('{"__proto__":{"bound":true}}') };

    expect(canonicalJson(withProtoKey)).not.toBe(canonicalJson({ extra: {} }));
    expect(canonicalJson(withProtoKey)).toContain('"__proto__"');
  });

  it('rejects executable or non-JSON object surfaces without invoking getters', () => {
    let getterInvoked = false;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return 'unsafe';
      },
    });
    const symbolKey = { visible: true, [Symbol('hidden')]: true };
    const proxy = new Proxy({ visible: true }, {});
    const sparse = Array(1);
    const extended = Object.assign([1], { extra: true });

    expect(() => canonicalJson(accessor)).toThrow('accessor property');
    expect(getterInvoked).toBe(false);
    expect(() => canonicalJson(symbolKey)).toThrow('symbol key');
    expect(() => canonicalJson(proxy)).toThrow('proxy');
    expect(() => canonicalJson(sparse)).toThrow('sparse or extended array');
    expect(() => canonicalJson(extended)).toThrow('sparse or extended array');
  });
});
