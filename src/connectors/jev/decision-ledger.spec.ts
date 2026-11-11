import { describe, expect, it, vi } from 'vitest';
import { request as decisionRequest } from './decision.fixture';
import {
  buildDecisionLedgerRow,
  recordDecisionLedgerIfApplicable,
  TYPESAFE_JEV_DIRECT_ROUTE,
} from './decision-ledger';
import { decisionIdentityDigest } from './decision-ledger.contract';

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-ledger-1',
    connector: 'typesafe-jev',
    model: 'jev-fixture',
    result: '',
    structured: {
      version: 'DecisionResult/v1',
      mode: 'shadow',
      action: 'none',
      decisionType: 'task-routing',
      policyId: 'fixture-v1',
      requestSha256: 'a'.repeat(64),
      requestedModel: 'jev-latest',
      observedModel: 'jev-fixture',
      status: 'observed',
      reason: null,
      answers: {
        tier: { primitive: 'choice', choice: 'small', confidence: 0.6, probabilities: null },
      },
    },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0,
      usageMissing: true as const,
    },
    latencyMs: 42,
    status: 'success' as const,
    ...overrides,
  };
}

describe('DecisionLedger persist helpers', () => {
  it('builds a row with digests of input, template and route', () => {
    const row = buildDecisionLedgerRow({
      response: successResponse() as never,
      request: { prompt: JSON.stringify(decisionRequest), model: 'jev-latest' },
      apiKeyId: 'fixture-key',
      requestId: '33333333-3333-4333-8333-333333333333',
      costSource: 'unpriced',
    });
    expect(row).not.toBeNull();
    expect(row!.route).toBe(TYPESAFE_JEV_DIRECT_ROUTE);
    expect(row!.identityDigest).toBe(
      decisionIdentityDigest({
        stateDigest: row!.stateDigest,
        templateDigest: row!.templateDigest,
        route: row!.route,
      }),
    );
    expect(row!.costUsd).toBeNull();
    expect(row!.usageMissing).toBe(true);
  });

  it('identical input replay yields one insert (skipDuplicates)', async () => {
    const createMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const tx = { decisionLedger: { createMany } };
    const args = {
      response: successResponse() as never,
      request: { prompt: JSON.stringify(decisionRequest), model: 'jev-latest' },
      apiKeyId: 'fixture-key',
      requestId: '33333333-3333-4333-8333-333333333333',
      costSource: 'unpriced' as const,
    };
    expect(await recordDecisionLedgerIfApplicable(tx, args)).toBe(1);
    expect(await recordDecisionLedgerIfApplicable(tx, args)).toBe(0);
    expect(createMany).toHaveBeenCalledTimes(2);
    const first = createMany.mock.calls[0][0];
    const second = createMany.mock.calls[1][0];
    expect(first.data[0].identityDigest).toBe(second.data[0].identityDigest);
    expect(first.skipDuplicates).toBe(true);
  });

  it('ignores non-jev connectors', async () => {
    const createMany = vi.fn();
    const count = await recordDecisionLedgerIfApplicable(
      { decisionLedger: { createMany } },
      {
        response: { ...successResponse(), connector: 'deepseek' } as never,
        request: { prompt: JSON.stringify(decisionRequest) },
        apiKeyId: 'fixture-key',
        requestId: '33333333-3333-4333-8333-333333333333',
        costSource: null,
      },
    );
    expect(count).toBeNull();
    expect(createMany).not.toHaveBeenCalled();
  });
});
