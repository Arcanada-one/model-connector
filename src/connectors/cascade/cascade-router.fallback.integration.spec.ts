// CONN-0223 — Cascade router fallback integration tests (T1-T7).
// Uses mock connector injection — no real HTTP calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CascadeRouterService } from './cascade-router.service';
import { CascadeExhaustedError, CascadeBudgetExceededError } from './cascade.errors';

vi.mock('../../config/env.schema', () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from '../../config/env.schema';

function success(connector = 'openmodel', model = 'deepseek-v4-flash', costUsd = 0) {
  return {
    id: 'resp-id',
    connector,
    model,
    result: 'ok',
    usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, costUsd },
    latencyMs: 80,
    status: 'success' as const,
  };
}

function err(
  errorType: string,
  connector = 'openmodel',
  model = 'deepseek-v4-flash',
  retryable = true,
) {
  return {
    id: 'resp-id',
    connector,
    model,
    result: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    latencyMs: 40,
    status: 'error' as const,
    error: {
      type: errorType,
      message: `Simulated ${errorType}`,
      retryable,
      recommendation: retryable ? ('retry' as const) : ('abort' as const),
    },
  };
}

function makeRouter(
  responses: Array<ReturnType<typeof success> | ReturnType<typeof err>>,
  configOverride?: Partial<ReturnType<typeof getConfig>>,
) {
  vi.mocked(getConfig).mockReturnValue({
    CASCADE_LOW_REASONING_ORDER:
      'openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free,openrouter:deepseek-v4-flash:paid',
    CASCADE_PAID_ENABLED: false,
    CASCADE_PAID_DAILY_BUDGET_USD: 0.17,
    ...configOverride,
  } as ReturnType<typeof getConfig>);

  let idx = 0;
  const mockConnectorsService = {
    execute: vi.fn(() => Promise.resolve(responses[idx++] ?? err('server_error'))),
  };
  const mockMetrics = { recordCascade: vi.fn() };

  const router = new CascadeRouterService(
    mockConnectorsService as unknown as ConstructorParameters<typeof CascadeRouterService>[0],
    mockMetrics as unknown as ConstructorParameters<typeof CascadeRouterService>[1],
  );

  return { router, mockConnectorsService, mockMetrics };
}

describe('CascadeRouter fallback integration (T1-T7)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('T1: free success → success, fallbackCount=0, freeTierHit=true', async () => {
    const { router, mockConnectorsService, mockMetrics } = makeRouter([
      success('openmodel', 'deepseek-v4-flash'),
    ]);

    const result = await router.execute('low-reasoning', { prompt: 'ping' }, 'k1');

    expect(result.status).toBe('success');
    expect(mockConnectorsService.execute).toHaveBeenCalledTimes(1);
    expect(mockMetrics.recordCascade).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        fallbackCount: 0,
        freeTierHit: true,
        tier: 'free',
      }),
    );
  });

  it('T2: free rate_limited → free2 success → fallbackCount=1, freeTierHit=true', async () => {
    const { router, mockConnectorsService, mockMetrics } = makeRouter(
      [
        err('rate_limited', 'openmodel', 'deepseek-v4-flash'),
        success('openrouter', 'meta-llama/llama-4-maverick'),
      ],
      { CASCADE_PAID_ENABLED: false },
    );

    const result = await router.execute('low-reasoning', { prompt: 'ping' }, 'k1');

    expect(result.status).toBe('success');
    expect(mockConnectorsService.execute).toHaveBeenCalledTimes(2);
    expect(mockMetrics.recordCascade).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackCount: 1, freeTierHit: true }),
    );
  });

  it('T3: free2 server_error → paid success (CASCADE_PAID_ENABLED=true) → fallbackCount=2', async () => {
    const { router, mockConnectorsService, mockMetrics } = makeRouter(
      [
        err('server_error', 'openmodel', 'deepseek-v4-flash'),
        err('server_error', 'openrouter', 'meta-llama/llama-4-maverick'),
        success('openrouter', 'deepseek-v4-flash'),
      ],
      { CASCADE_PAID_ENABLED: true },
    );

    const result = await router.execute('low-reasoning', { prompt: 'ping' }, 'k1');

    expect(result.status).toBe('success');
    expect(mockConnectorsService.execute).toHaveBeenCalledTimes(3);
    expect(mockMetrics.recordCascade).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackCount: 2, tier: 'paid' }),
    );
  });

  it('T4: rate_limited × 2 → paid OFF → CascadeExhaustedError', async () => {
    const { router, mockConnectorsService } = makeRouter(
      [
        err('rate_limited', 'openmodel', 'deepseek-v4-flash'),
        err('rate_limited', 'openrouter', 'meta-llama/llama-4-maverick'),
      ],
      { CASCADE_PAID_ENABLED: false },
    );

    await expect(router.execute('low-reasoning', { prompt: 'ping' }, 'k1')).rejects.toThrow(
      CascadeExhaustedError,
    );
    expect(mockConnectorsService.execute).toHaveBeenCalledTimes(2);
  });

  it('T5: circuit_open × 2 → paid success → success', async () => {
    const { router, mockConnectorsService } = makeRouter(
      [
        err('circuit_open', 'openmodel', 'deepseek-v4-flash'),
        err('circuit_open', 'openrouter', 'meta-llama/llama-4-maverick'),
        success('openrouter', 'deepseek-v4-flash'),
      ],
      { CASCADE_PAID_ENABLED: true },
    );

    const result = await router.execute('low-reasoning', { prompt: 'ping' }, 'k1');

    expect(result.status).toBe('success');
    expect(mockConnectorsService.execute).toHaveBeenCalledTimes(3);
  });

  it('T6: server_error × 2 → paid over budget → CascadeBudgetExceededError, no HTTP to paid', async () => {
    const { router, mockConnectorsService } = makeRouter(
      [
        err('server_error', 'openmodel', 'deepseek-v4-flash'),
        err('server_error', 'openrouter', 'meta-llama/llama-4-maverick'),
        // paid would be next but should not be called
      ],
      { CASCADE_PAID_ENABLED: true, CASCADE_PAID_DAILY_BUDGET_USD: 0.05 },
    );

    // Pre-load budget to exceeded state
    (router as unknown as { dailyPaidCostUsd: number }).dailyPaidCostUsd = 0.05;

    await expect(router.execute('low-reasoning', { prompt: 'ping' }, 'k1')).rejects.toThrow(
      CascadeBudgetExceededError,
    );
    expect(mockConnectorsService.execute).toHaveBeenCalledTimes(2);
  });

  it('T7: abort-class error → stop immediately', async () => {
    const { router, mockConnectorsService } = makeRouter([
      err('validation_error', 'openmodel', 'deepseek-v4-flash', false),
    ]);

    await expect(router.execute('low-reasoning', { prompt: 'ping' }, 'k1')).rejects.toThrow(
      CascadeExhaustedError,
    );
    expect(mockConnectorsService.execute).toHaveBeenCalledTimes(1);
  });
});
