// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { buildDecisionPrompt, judge, parseArgs } from './smoke-typesafe-jev.mjs';

describe('buildDecisionPrompt', () => {
  it('emits DecisionRequest/v1 with jev-latest and shadow mode', () => {
    const parsed = JSON.parse(buildDecisionPrompt('synthetic'));
    expect(parsed).toMatchObject({
      version: 'DecisionRequest/v1',
      mode: 'shadow',
      model: 'jev-latest',
      state: 'synthetic',
      policyId: 'conn-jev-04-smoke-v1',
    });
    expect(Object.keys(parsed.questions).sort()).toEqual(['complexity', 'risk', 'tier']);
  });
});

describe('judge', () => {
  const okBody = {
    id: 'req-1',
    connector: 'typesafe-jev',
    model: 'jev-latest',
    status: 'success',
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      costUsd: 0.0012,
      costSource: 'catalog',
    },
    structured: {
      status: 'observed',
      mode: 'shadow',
      action: 'none',
      requestedModel: 'jev-latest',
      observedModel: 'jev-fixture',
      policyId: 'conn-jev-04-smoke-v1',
    },
  };

  it('PASS on 201 + observed + priced paid cost', () => {
    expect(judge({ httpStatus: 201, body: okBody })).toEqual({
      verdict: 'PASS',
      reasons: [],
      observations: expect.objectContaining({
        httpStatus: 201,
        bodyStatus: 'success',
        structuredStatus: 'observed',
        costUsd: 0.0012,
        costSource: 'catalog',
      }),
    });
  });

  it('FAIL when HTTP is not 201 even if body looks successful', () => {
    const r = judge({ httpStatus: 200, body: okBody });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.some((x) => x.includes('HTTP 201'))).toBe(true);
  });

  it('FAIL A2-223 negative control: paid costSource with costUsd=0', () => {
    const r = judge({
      httpStatus: 201,
      body: {
        ...okBody,
        usage: { ...okBody.usage, costUsd: 0, costSource: 'provider' },
      },
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.some((x) => x.includes('A2-223'))).toBe(true);
  });

  it('FAIL A2-223-class unpriced zero after a successful serve', () => {
    const r = judge({
      httpStatus: 201,
      body: {
        ...okBody,
        usage: { ...okBody.usage, costUsd: 0, costSource: 'unpriced' },
      },
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.some((x) => x.includes('unpriced'))).toBe(true);
  });

  it('FAIL when route refuses (status=error) even if Nest returns 201', () => {
    const r = judge({
      httpStatus: 201,
      body: {
        id: 'req-2',
        connector: 'typesafe-jev',
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        error: {
          type: 'validation_error',
          message: 'JEV route_not_configured',
          details: { code: 'route_not_configured' },
        },
      },
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.observations.errorCode).toBe('route_not_configured');
    expect(r.reasons.some((x) => x.includes('body.status=success'))).toBe(true);
  });

  it('FAIL when usage.costUsd field is absent', () => {
    const { costUsd: _drop, ...usageNoCost } = okBody.usage;
    const r = judge({
      httpStatus: 201,
      body: { ...okBody, usage: usageNoCost },
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.some((x) => x.includes('usage.costUsd missing'))).toBe(true);
  });

  it('PASS catalog-free zero (explicit free price, not silent unpaid)', () => {
    const r = judge({
      httpStatus: 201,
      body: {
        ...okBody,
        usage: { ...okBody.usage, costUsd: 0, costSource: 'catalog-free' },
      },
    });
    expect(r.verdict).toBe('PASS');
  });
});

describe('parseArgs', () => {
  it('defaults base URL and accepts overrides', () => {
    expect(parseArgs([])).toMatchObject({
      baseUrl: 'https://connector.arcanada.ai',
      receiptPath: null,
    });
    expect(
      parseArgs(['--base-url', 'https://example.test', '--receipt', '/tmp/r.json']),
    ).toMatchObject({
      baseUrl: 'https://example.test',
      receiptPath: '/tmp/r.json',
    });
  });

  it('refuses unknown args', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });
});
