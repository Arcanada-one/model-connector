/**
 * ARAS-0064 — the credit gate at the dispatch choke point.
 *
 * The billing integration tests exercise BillingService directly. They proved
 * the ledger arithmetic and the idempotency constraint, and they proved
 * nothing about whether `execute()` actually consults any of it — which it did
 * not, initially: `precheck` was implemented, tested, and never wired, so a
 * zero balance did not block a call. Green tests over an unwired feature.
 *
 * These tests drive `execute()` and assert on what a CALLER sees.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { estimateCostUsd, UNKNOWN_MODEL_ESTIMATE_USD } from './cost-estimate';

describe('estimateCostUsd', () => {
  it('falls back to a positive floor for an uncatalogued model', () => {
    // Zero here would make an unpriced model free to call on an empty balance —
    // exactly when the account is least protected.
    expect(estimateCostUsd(1000, null)).toBe(UNKNOWN_MODEL_ESTIMATE_USD);
    expect(estimateCostUsd(1000, { inputPerMTok: null, outputPerMTok: null })).toBe(
      UNKNOWN_MODEL_ESTIMATE_USD,
    );
  });

  it('estimates zero for a catalogued free model', () => {
    // A free call must stay affordable on a zero balance.
    expect(estimateCostUsd(10_000, { inputPerMTok: 0, outputPerMTok: 0 })).toBe(0);
  });

  it('scales with prompt length and price', () => {
    const cheap = estimateCostUsd(4_000, { inputPerMTok: 1, outputPerMTok: 1 });
    const dear = estimateCostUsd(4_000, { inputPerMTok: 100, outputPerMTok: 100 });
    expect(dear).toBeGreaterThan(cheap);
    expect(cheap).toBeGreaterThan(0);
  });

  it('assumes output tokens rather than pricing only the prompt', () => {
    // Pre-call the response length is unknown; pricing only the prompt would
    // under-estimate every request and let accounts go negative.
    const promptOnly = estimateCostUsd(4_000, { inputPerMTok: 10, outputPerMTok: 0 });
    const withOutput = estimateCostUsd(4_000, { inputPerMTok: 10, outputPerMTok: 10 });
    expect(withOutput).toBeGreaterThan(promptOnly);
  });
});

describe('credit gate at the dispatch choke point', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
  });

  /** Minimal env the schema accepts, mirroring env.schema.spec.ts. */
  const BASE_ENV = {
    PORT: '3900',
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '6379',
    REDIS_PREFIX: 'conn:',
    API_KEY_SALT_ROUNDS: '10',
    CONNECTOR_TIMEOUT_MS: '300000',
    CONNECTOR_MAX_CONCURRENCY: '1',
    STT_GROQ_API_KEY: 'test-groq-key',
  };

  async function buildService(opts: { enforced: boolean; balanceUsd: number }) {
    const { validateEnv } = await import('../config/env.schema');
    // Prime the cached config so getConfig() inside execute() sees our flag
    // instead of validating the ambient process env.
    validateEnv({ ...BASE_ENV, BILLING_ENFORCED: opts.enforced ? 'true' : 'false' });

    const { ConnectorsService } = await import('../connectors/connectors.service');
    const { BillingService } = await import('./billing.service');

    const prisma = {
      creditsBalance: {
        findUnique: vi.fn(async () => ({ balanceUsd: { lessThan: () => false } })),
      },
    };
    const billing = new BillingService(prisma as never);
    // Balance is stubbed at the service boundary so this spec is about the
    // GATE, not about ledger arithmetic (covered by the integration spec).
    vi.spyOn(billing, 'balance').mockResolvedValue({
      lessThan: (required: { toString(): string }) => opts.balanceUsd < Number(required.toString()),
      toString: () => String(opts.balanceUsd),
    } as never);

    const connector = {
      name: 'groq',
      type: 'api',
      execute: vi.fn(async () => ({
        id: 'r1',
        connector: 'groq',
        model: 'llama',
        result: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.001 },
        latencyMs: 5,
        status: 'success' as const,
      })),
      getStatus: vi.fn().mockReturnValue({ rateLimitStatus: 'ok' }),
      getCapabilities: vi.fn().mockReturnValue({
        name: 'groq',
        type: 'api',
        models: ['llama'],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 300000,
      }),
    };

    const service = new ConnectorsService(
      { add: vi.fn() } as never,
      { request: { create: vi.fn(async () => ({ id: 'req-1' })) } } as never,
      { record: vi.fn(), recordFailover: vi.fn() } as never,
      { process: vi.fn(async (r: unknown) => r) } as never,
      undefined,
      {
        findAll: async () => [
          { connector: 'groq', model: 'llama', inputPerMTok: 5, outputPerMTok: 5 },
        ],
      } as never,
      null,
      undefined,
      undefined,
      billing,
    );
    service.register(connector as never);
    return { service, connector };
  }

  it('refuses the call when the balance cannot cover the estimate', async () => {
    const { service, connector } = await buildService({ enforced: true, balanceUsd: 0 });

    const response = await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');

    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('credit_depleted');
    expect(response.error?.retryable).toBe(false);
    expect(response.error?.message).toMatch(/insufficient credits/i);
    // The whole point of prechecking: the provider is never called, so no money
    // is spent on a request the account cannot pay for.
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it('allows the call when the balance covers the estimate', async () => {
    const { service, connector } = await buildService({ enforced: true, balanceUsd: 100 });

    const response = await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');

    expect(response.status).toBe('success');
    expect(connector.execute).toHaveBeenCalledTimes(1);
  });

  it('does not gate at all while BILLING_ENFORCED is off', async () => {
    // The dark-ship guarantee: a zero balance must NOT break a live caller
    // until an operator opts in.
    const { service, connector } = await buildService({ enforced: false, balanceUsd: 0 });

    const response = await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');

    expect(response.status).toBe('success');
    expect(connector.execute).toHaveBeenCalledTimes(1);
  });
});
