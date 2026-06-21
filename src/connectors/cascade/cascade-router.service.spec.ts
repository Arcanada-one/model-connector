// CONN-0223 — CascadeRouterService unit tests (T1-T7 test matrix).
// All tests use mocked ConnectorsService — no real HTTP.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CascadeRouterService } from './cascade-router.service';
import { CascadeExhaustedError, CascadeBudgetExceededError } from './cascade.errors';

// Mock getConfig to control env
vi.mock('../../config/env.schema', () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from '../../config/env.schema';

function makeSuccessResponse(connector = 'openmodel', model = 'deepseek-v4-flash') {
  return {
    id: 'test-id',
    connector,
    model,
    result: 'Hello',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 },
    latencyMs: 100,
    status: 'success' as const,
  };
}

function makeErrorResponse(
  errorType: string,
  connector = 'openmodel',
  model = 'deepseek-v4-flash',
  retryable = true,
) {
  return {
    id: 'test-id',
    connector,
    model,
    result: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    latencyMs: 50,
    status: 'error' as const,
    error: {
      type: errorType,
      message: `Mock ${errorType}`,
      retryable,
      recommendation: retryable ? ('retry' as const) : ('abort' as const),
    },
  };
}

function makeMockConnectorsService(
  responses: Array<ReturnType<typeof makeSuccessResponse> | ReturnType<typeof makeErrorResponse>>,
) {
  let callIndex = 0;
  return {
    execute: vi.fn((_connector: string, _request: unknown, _apiKeyId: string) => {
      const item = responses[callIndex++];
      return Promise.resolve(item ?? makeErrorResponse('server_error'));
    }),
  };
}

function makeMockMetrics() {
  return { recordCascade: vi.fn() };
}

describe('CascadeRouterService (T1-T7)', () => {
  let mockConfig: ReturnType<typeof getConfig>;

  beforeEach(() => {
    mockConfig = {
      CASCADE_LOW_REASONING_ORDER:
        'openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free,openrouter:deepseek-v4-flash:paid',
      CASCADE_PAID_ENABLED: false,
      CASCADE_PAID_DAILY_BUDGET_USD: 0.17,
    } as ReturnType<typeof getConfig>;
    vi.mocked(getConfig).mockReturnValue(mockConfig);
  });

  it('T1: free success → success, fallbackCount=0, freeTierHit=true', async () => {
    const mockService = makeMockConnectorsService([
      makeSuccessResponse('openmodel', 'deepseek-v4-flash'),
    ]);
    const mockMetrics = makeMockMetrics();

    const router = new CascadeRouterService(
      mockService as unknown as ConstructorParameters<typeof CascadeRouterService>[0],
      mockMetrics as unknown as ConstructorParameters<typeof CascadeRouterService>[1],
    );

    const result = await router.execute('low-reasoning', { prompt: 'hello' }, 'key-1');
    expect(result.status).toBe('success');
    expect(mockService.execute).toHaveBeenCalledTimes(1);
    expect(mockMetrics.recordCascade).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', fallbackCount: 0, freeTierHit: true }),
    );
  });

  it('T2: free rate_limited → free2 success → fallbackCount=1, freeTierHit=true', async () => {
    mockConfig.CASCADE_PAID_ENABLED = false;
    mockConfig.CASCADE_LOW_REASONING_ORDER =
      'openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free';
    const mockService = makeMockConnectorsService([
      makeErrorResponse('rate_limited', 'openmodel', 'deepseek-v4-flash'),
      makeSuccessResponse('openrouter', 'meta-llama/llama-4-maverick'),
    ]);
    const mockMetrics = makeMockMetrics();

    const router = new CascadeRouterService(
      mockService as unknown as ConstructorParameters<typeof CascadeRouterService>[0],
      mockMetrics as unknown as ConstructorParameters<typeof CascadeRouterService>[1],
    );

    const result = await router.execute('low-reasoning', { prompt: 'hello' }, 'key-1');
    expect(result.status).toBe('success');
    expect(mockService.execute).toHaveBeenCalledTimes(2);
    expect(mockMetrics.recordCascade).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackCount: 1, freeTierHit: true }),
    );
  });

  it('T3: free server_error → free2 server_error → paid success (CASCADE_PAID_ENABLED=true) → fallbackCount=2', async () => {
    mockConfig.CASCADE_PAID_ENABLED = true;
    mockConfig.CASCADE_LOW_REASONING_ORDER =
      'openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free,openrouter:deepseek-v4-flash:paid';
    const mockService = makeMockConnectorsService([
      makeErrorResponse('server_error', 'openmodel', 'deepseek-v4-flash'),
      makeErrorResponse('server_error', 'openrouter', 'meta-llama/llama-4-maverick'),
      makeSuccessResponse('openrouter', 'deepseek-v4-flash'),
    ]);
    const mockMetrics = makeMockMetrics();

    const router = new CascadeRouterService(
      mockService as unknown as ConstructorParameters<typeof CascadeRouterService>[0],
      mockMetrics as unknown as ConstructorParameters<typeof CascadeRouterService>[1],
    );

    const result = await router.execute('low-reasoning', { prompt: 'hello' }, 'key-1');
    expect(result.status).toBe('success');
    expect(mockService.execute).toHaveBeenCalledTimes(3);
    expect(mockMetrics.recordCascade).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackCount: 2, tier: 'paid' }),
    );
  });

  it('T4: rate_limited × 2 → paid OFF → CascadeExhaustedError (typed)', async () => {
    mockConfig.CASCADE_PAID_ENABLED = false;
    mockConfig.CASCADE_LOW_REASONING_ORDER =
      'openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free';
    const mockService = makeMockConnectorsService([
      makeErrorResponse('rate_limited', 'openmodel', 'deepseek-v4-flash'),
      makeErrorResponse('rate_limited', 'openrouter', 'meta-llama/llama-4-maverick'),
    ]);
    const mockMetrics = makeMockMetrics();

    const router = new CascadeRouterService(
      mockService as unknown as ConstructorParameters<typeof CascadeRouterService>[0],
      mockMetrics as unknown as ConstructorParameters<typeof CascadeRouterService>[1],
    );

    await expect(router.execute('low-reasoning', { prompt: 'hello' }, 'key-1')).rejects.toThrow(
      CascadeExhaustedError,
    );
    expect(mockService.execute).toHaveBeenCalledTimes(2);
  });

  it('T5: circuit_open × 2 → paid success → success', async () => {
    mockConfig.CASCADE_PAID_ENABLED = true;
    mockConfig.CASCADE_LOW_REASONING_ORDER =
      'openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free,openrouter:deepseek-v4-flash:paid';
    const mockService = makeMockConnectorsService([
      makeErrorResponse('circuit_open', 'openmodel', 'deepseek-v4-flash'),
      makeErrorResponse('circuit_open', 'openrouter', 'meta-llama/llama-4-maverick'),
      makeSuccessResponse('openrouter', 'deepseek-v4-flash'),
    ]);
    const mockMetrics = makeMockMetrics();

    const router = new CascadeRouterService(
      mockService as unknown as ConstructorParameters<typeof CascadeRouterService>[0],
      mockMetrics as unknown as ConstructorParameters<typeof CascadeRouterService>[1],
    );

    const result = await router.execute('low-reasoning', { prompt: 'hello' }, 'key-1');
    expect(result.status).toBe('success');
    expect(mockService.execute).toHaveBeenCalledTimes(3);
  });

  it('T6: server_error × 2 → paid over budget → CascadeBudgetExceededError, NO outbound HTTP to paid', async () => {
    mockConfig.CASCADE_PAID_ENABLED = true;
    mockConfig.CASCADE_LOW_REASONING_ORDER =
      'openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free,openrouter:deepseek-v4-flash:paid';
    mockConfig.CASCADE_PAID_DAILY_BUDGET_USD = 0.1;

    const mockService = makeMockConnectorsService([
      makeErrorResponse('server_error', 'openmodel', 'deepseek-v4-flash'),
      makeErrorResponse('server_error', 'openrouter', 'meta-llama/llama-4-maverick'),
      // T6: paid should NOT be called
    ]);
    const mockMetrics = makeMockMetrics();

    const router = new CascadeRouterService(
      mockService as unknown as ConstructorParameters<typeof CascadeRouterService>[0],
      mockMetrics as unknown as ConstructorParameters<typeof CascadeRouterService>[1],
    );

    // Pre-load the daily budget to exceed it
    (router as unknown as { dailyPaidCostUsd: number }).dailyPaidCostUsd = 0.1;

    await expect(router.execute('low-reasoning', { prompt: 'hello' }, 'key-1')).rejects.toThrow(
      CascadeBudgetExceededError,
    );
    // Only 2 calls (free tier), NOT 3 (paid should be blocked)
    expect(mockService.execute).toHaveBeenCalledTimes(2);
  });

  it('T7: abort-class error → stop immediately, typed CascadeExhaustedError', async () => {
    mockConfig.CASCADE_LOW_REASONING_ORDER =
      'openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free';
    const abortResponse = makeErrorResponse('auth_error', 'openmodel', 'deepseek-v4-flash', false);

    const mockService = makeMockConnectorsService([abortResponse]);
    const mockMetrics = makeMockMetrics();

    const router = new CascadeRouterService(
      mockService as unknown as ConstructorParameters<typeof CascadeRouterService>[0],
      mockMetrics as unknown as ConstructorParameters<typeof CascadeRouterService>[1],
    );

    await expect(router.execute('low-reasoning', { prompt: 'hello' }, 'key-1')).rejects.toThrow(
      CascadeExhaustedError,
    );
    // Only 1 call (abort stops cascade immediately)
    expect(mockService.execute).toHaveBeenCalledTimes(1);
  });
});
