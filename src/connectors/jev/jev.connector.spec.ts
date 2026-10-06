import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionRequestSchema, normalizeDecision } from './decision.contract';
import { JevConnector } from './jev.connector';

import { request, nativeResponse as historicalNativeResponse } from './decision.fixture';

// Keep the historical fixture immutable; use the documented provider confidence.
const nativeResponse = {
  ...historicalNativeResponse,
  answers: {
    ...historicalNativeResponse.answers,
    tier: { ...historicalNativeResponse.answers.tier, confidence: 0.6 },
  },
};

describe('native decision contract and adapter', () => {
  let connector: JevConnector;
  const fetchMock = vi.fn();
  const execute = () => connector.execute({ prompt: JSON.stringify(request), model: 'jev-latest' });
  beforeEach(() => {
    vi.stubEnv('JEV_ENABLED', 'true');
    vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-key');
    connector = new JevConnector();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  function reply(body: unknown, status = 200) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  }

  it('sends exact native primitives without inventing Noul criteria; returns provenance and full precision', async () => {
    reply(nativeResponse);
    const response = await execute();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Bearer synthetic-key');
    expect(JSON.parse(init.body)).toEqual({
      model: 'jev-latest',
      state: request.state,
      questions: request.questions,
    });
    expect(response.status).toBe('success');
    expect(response.structured).toMatchObject({
      status: 'observed',
      mode: 'shadow',
      action: 'none',
      observedModel: 'jev-fixture-version',
      requestedModel: 'jev-latest',
      policyId: 'fixture-v1',
      answers: {
        risk: { noul: 0.6996 },
        complexity: { score: 2.4 },
        tier: { probabilities: { small: 0.8, large: 0.2 } },
      },
    });
    expect(response.usage.usageMissing).toBe(true);
  });

  it('preserves measured provider token usage separately from missing counters', async () => {
    reply({ ...nativeResponse, usage: { input_tokens: 12, output_tokens: 3 } });
    const measured = await execute();
    expect(measured.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      providerUsage: { input_tokens: 12, output_tokens: 3 },
    });
    expect(measured.usage.usageMissing).toBeUndefined();
    reply({ ...nativeResponse, usage: { other_counter: 7 } });
    expect((await execute()).usage).toMatchObject({
      usageMissing: true,
      providerUsage: { other_counter: 7 },
    });
  });

  it.each(['', 'false', '1'])(
    'is off for flag %s, including status and catalog refresh',
    async (flag) => {
      vi.stubEnv('JEV_ENABLED', flag);
      expect((await execute()).status).toBe('error');
      expect((await connector.getStatus()).healthy).toBe(false);
      expect((await connector.refreshCatalogModels()).status).toBe('failed');
      expect(connector.getCapabilities().models).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('missing provider credential refuses without a call', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    expect((await execute()).status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects malformed native envelopes before network and suppresses payloads', async () => {
    const response = await connector.execute({ prompt: '{"secret-task":', model: 'jev-latest' });
    expect(response.error?.retryable).toBe(false);
    expect(JSON.stringify(response)).not.toContain('secret-task');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects executable mode, unsupported native types, empty criteria and unknown request fields', () => {
    const bad = [
      { ...request, mode: 'apply' },
      { ...request, endpoint: 'https://attacker' },
      { ...request, questions: { x: { type: 'multiselect', instructions: 'Pick' } } },
      { ...request, questions: { x: { type: 'choice', instructions: 'Pick', criteria: {} } } },
    ];
    for (const value of bad) expect(DecisionRequestSchema.safeParse(value).success).toBe(false);
  });
  it('does not accept generic chat options or an alternate model', async () => {
    for (const extra of [
      { extra: { url: 'https://attacker' } },
      { systemPrompt: 'override' },
      { model: 'other' },
    ]) {
      expect((await connector.execute({ prompt: JSON.stringify(request), ...extra })).status).toBe(
        'error',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { answers: { ...nativeResponse.answers, extra: { noul: 0.5 } } },
    { answers: { tier: nativeResponse.answers.tier } },
    { answers: { ...nativeResponse.answers, risk: { noul: NaN } } },
    { answers: { ...nativeResponse.answers, risk: { noul: 1.1 } } },
    { answers: { ...nativeResponse.answers, complexity: { score: 4 } } },
    { answers: { ...nativeResponse.answers, tier: { choice: 'invented', confidence: 1 } } },
    {
      answers: {
        ...nativeResponse.answers,
        tier: { choice: 'small', probabilities: { small: 0.8 } },
      },
    },
    {
      answers: {
        ...nativeResponse.answers,
        tier: { choice: 'small', confidence: 0.9, probabilities: { small: 0.8, large: 0.2 } },
      },
    },
  ])('malformed/partial answer produces atomic unknown, never zero/default action', (response) => {
    expect(normalizeDecision(request, response)).toMatchObject({
      status: 'unknown',
      action: 'none',
      answers: {},
    });
  });
  it('missing confidence/distribution/model stays null, not fabricated', () => {
    const result = normalizeDecision(request, {
      answers: { ...nativeResponse.answers, tier: { choice: 'small' } },
    });
    expect(result.observedModel).toBeNull();
    expect(result.answers.tier).toEqual({
      primitive: 'choice',
      choice: 'small',
      confidence: null,
      probabilities: null,
    });
  });
  it.each([
    [{ small: 0.8, large: 0.2 }, 0.6],
    [{ small: 0.5, large: 0.5 }, 0],
    [{ small: 1, large: 0 }, 1],
  ])('accepts provider-normalized binary confidence %j -> %s', (probabilities, confidence) => {
    const result = normalizeDecision(request, {
      ...nativeResponse,
      answers: { ...nativeResponse.answers, tier: { choice: 'small', probabilities, confidence } },
    });
    expect(result).toMatchObject({ status: 'observed', action: 'none', mode: 'shadow' });
    expect(result.answers.tier).toEqual({ primitive: 'choice', choice: 'small', probabilities, confidence });
    expect(result.answers.complexity).toEqual({ primitive: 'score', score: 2.4 });
    expect(result.answers.risk).toEqual({ primitive: 'noul', noul: 0.6996 });
  });
  it('uses the complete option count for three-way confidence', () => {
    const three = { ...request, questions: {
      tier: { type: 'choice' as const, instructions: 'Choose', criteria: { small: 'Small', large: 'Large', other: 'Other' } },
    } };
    expect(normalizeDecision(three, { answers: { tier: {
      choice: 'small', probabilities: { small: 0.6, large: 0.3, other: 0.1 }, confidence: 0.4,
    } } })).toMatchObject({ status: 'observed', action: 'none' });
  });
  it.each([0.8, -0.1, 1.1, true, NaN, Infinity])('refuses inconsistent or malformed confidence %s atomically', (confidence) => {
    expect(normalizeDecision(request, { ...nativeResponse, answers: {
      ...nativeResponse.answers, tier: { ...nativeResponse.answers.tier, confidence },
    } })).toMatchObject({ status: 'unknown', action: 'none', answers: {} });
  });
  it('preserves absence of confidence even with a valid distribution', () => {
    expect(normalizeDecision(request, { answers: { ...nativeResponse.answers,
      tier: { choice: 'small', probabilities: { small: 0.8, large: 0.2 } },
    } }).answers.tier).toEqual({ primitive: 'choice', choice: 'small',
      confidence: null, probabilities: { small: 0.8, large: 0.2 } });
  });
  it('does not retrofit the historical probability-as-confidence fixture', () => {
    expect(normalizeDecision(request, historicalNativeResponse)).toMatchObject({ status: 'unknown', action: 'none', answers: {} });
  });
  it('request digest binds policy and native state', () => {
    const first = normalizeDecision(request, nativeResponse).requestSha256;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(
      normalizeDecision({ ...request, policyId: 'different' }, nativeResponse).requestSha256,
    ).not.toBe(first);
    expect(
      normalizeDecision({ ...request, state: 'Other' }, nativeResponse).requestSha256,
    ).not.toBe(first);
  });
  it('invalid provider response is an error and no successful empty decision', async () => {
    reply({ answers: {} });
    expect((await execute()).status).toBe('error');
  });
  it.each([401, 429, 503])('upstream HTTP %i never echoes body', async (status) => {
    reply({ error: 'private synthetic task or credential' }, status);
    const response = await execute();
    expect(response.status).not.toBe('success');
    expect(JSON.stringify(response)).not.toContain('private synthetic');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([200, 503])('bounds provider body before parsing HTTP %i', async (status) => {
    reply({ ...nativeResponse, ignored: 'x'.repeat(131072) }, status);
    expect((await execute()).status).toBe('error');
  });
  it('rejects declared oversize before reading body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    fetchMock.mockResolvedValue(new Response(stream, { headers: { 'content-length': '131073' } }));
    expect((await execute()).status).toBe('error');
    expect(cancel).toHaveBeenCalled();
  });
  it('refuses invalid JSON without exposing its body', async () => {
    fetchMock.mockResolvedValue(new Response('{private-sentinel'));
    const response = await execute();
    expect(response.status).toBe('error');
    expect(JSON.stringify(response)).not.toContain('private-sentinel');
  });

  it('timeout is bounded and exposes no transport payload', async () => {
    fetchMock.mockRejectedValue(new DOMException('sensitive-sentinel', 'TimeoutError'));
    const response = await execute();
    expect(response.status).toBe('timeout');
    expect(response.error?.retryable).toBe(false);
    expect(JSON.stringify(response)).not.toContain('sensitive-sentinel');
  });
});
