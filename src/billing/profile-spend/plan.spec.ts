import { expect, it } from 'vitest';
import { apiKeyPolicySchema } from '../../policy/policy.schema';
import { prepareSpend, type SpendRequest } from './plan';
import { buildDeepSeekRequestBody } from '../../connectors/deepseek/deepseek.connector';
const policy = () =>
  apiKeyPolicySchema.parse({
    policyVersion: 2,
    profile: { id: 'prime', revision: '1', accountingBucket: 'account' },
    providers: ['deepseek'],
    models: { mode: 'list', list: ['fixture-model'] },
    providerKeys: { deepseek: [{ credentialRef: 'fixture-ref', version: '1' }] },
    spend: {
      mode: 'strict',
      revision: 'policy-1',
      currency: 'USD',
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveUntil: '2027-01-01T00:00:00Z',
      client: { dailyLimit: '10', monthlyLimit: '10', runLimit: '10', maxConcurrent: 1 },
      providers: {
        deepseek: {
          profileId: 'profile',
          dailyLimit: '10',
          monthlyLimit: '10',
          models: {
            'fixture-model': {
              revision: 'tariff-1',
              sourceRef: 'fixture:tariff',
              validFrom: '2026-01-01T00:00:00Z',
              validUntil: '2027-01-01T00:00:00Z',
              inputPerMTok: '1',
              outputPerMTok: '2',
              inputTokenBound: 1024,
              maxOutputTokens: 128,
              maxPayloadBytes: 512,
              boundAuthority: 'fixture',
              capability: {
                id: 'fixture-capability',
                sha256: 'a'.repeat(64),
                provider: 'deepseek',
                model: 'fixture-model',
                validFrom: '2026-01-01T00:00:00Z',
                validUntil: '2027-01-01T00:00:00Z',
                inputTokenCeiling: 1024,
                outputTokenCeiling: 128,
                payloadByteCeiling: 512,
              },
            },
          },
        },
      },
    },
  });
const request = (): SpendRequest => ({
  prompt: 'private fixture',
  model: 'fixture-model',
  idempotencyKey: 'intent',
  spendContext: {
    version: 'profile-spend/v1',
    runId: 'run',
    operationId: 'operation',
    routeEpoch: 'epoch',
    nodes: ['node'],
  },
});
const credential = {
  provider: 'deepseek',
  apiKey: 'synthetic-fixture-only',
  credentialRef: 'fixture-ref',
  credentialVersion: '1',
};
const at = new Date('2026-10-08T12:00:00Z');
it('snapshots operation/epoch and exact adapter bytes, forwards bounded output with no retries', () => {
  const p = prepareSpend(policy(), 'deepseek', request(), 'key', credential, at);
  expect(p.reserve).toBe(1_280_000n);
  expect(p.requestBytes).toBe(
    Buffer.byteLength(JSON.stringify(buildDeepSeekRequestBody(p.request))),
  );
  expect(p.operationId).toBe('operation');
  expect(p.routeEpoch).toBe('epoch');
  expect(p.request.maxRetries).toBe(0);
  expect(p.request.extra?.max_tokens).toBe(128);
});
it.each(['missing', 'expired', 'model', 'output', 'bytes'])(
  'refuses %s capability/request qualification',
  (mode) => {
    const p = policy(),
      r = request();
    const t = p.spend!.providers.deepseek.models['fixture-model'];
    if (mode === 'missing') delete (t as unknown as Record<string, unknown>).capability;
    if (mode === 'expired') t.capability.validUntil = '2026-02-01T00:00:00Z';
    if (mode === 'model') t.capability.model = 'other-model';
    if (mode === 'output') t.capability.outputTokenCeiling = 127;
    if (mode === 'bytes') r.prompt = '🚫'.repeat(512);
    expect(() => prepareSpend(p, 'deepseek', r, 'key', credential, at)).toThrow();
  },
);
