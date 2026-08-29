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

import { estimateCostUsd, promptCharLength, UNKNOWN_MODEL_ESTIMATE_USD } from './cost-estimate';

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

  // ─── ARAS-0058 ──────────────────────────────────────────────────────────

  it('folds a caller-supplied max_tokens into the estimate', () => {
    // The finding: `max_tokens` was ignored entirely in favour of a hardcoded
    // 2 000, so a caller asking for 64 000 output tokens on an expensive model
    // was under-estimated by ~32x — by a parameter the CALLER chooses, which
    // makes it a spend-control bypass rather than an inaccuracy.
    const pricing = { inputPerMTok: 0, outputPerMTok: 100 };
    const assumed = estimateCostUsd(100, pricing);
    const asked = estimateCostUsd(100, pricing, { maxTokens: 64_000 });
    expect(asked).toBeCloseTo(assumed * 32, 6);
  });

  it('never lets a small max_tokens LOWER the estimate', () => {
    // Not every connector forwards max_tokens to its provider — the CLI ones
    // drop it — so a small value is a request, not a guarantee. Honouring it
    // downward would hand the caller a way to under-reserve.
    const pricing = { inputPerMTok: 0, outputPerMTok: 100 };
    expect(estimateCostUsd(100, pricing, { maxTokens: 1 })).toBe(estimateCostUsd(100, pricing));
  });

  it('ignores a max_tokens that is not a usable number', () => {
    // It arrives from an untrusted body. A NaN propagated into the estimate
    // would make the comparison against the balance false in BOTH directions
    // and silently disable the gate.
    const pricing = { inputPerMTok: 0, outputPerMTok: 100 };
    const baseline = estimateCostUsd(100, pricing);
    for (const bad of [NaN, Infinity, -5, 0, '64000', null, {}]) {
      expect(estimateCostUsd(100, pricing, { maxTokens: bad })).toBe(baseline);
    }
  });
});

describe('promptCharLength', () => {
  it('counts characters, not blocks, on a multi-modal prompt', () => {
    // The original estimate read `prompt?.length`, which on a ContentBlock[] is
    // the number of BLOCKS — a 40 000 character two-block prompt priced as
    // "2 characters".
    const blocks = [
      { type: 'text' as const, text: 'a'.repeat(20_000) },
      { type: 'text' as const, text: 'b'.repeat(20_000) },
    ];
    expect(promptCharLength(blocks)).toBe(40_000);
  });

  it('charges an image block a positive allowance rather than nothing', () => {
    const withImage = promptCharLength([
      { type: 'image_url' as const, image_url: { url: 'https://example.test/a.png' } },
    ]);
    expect(withImage).toBeGreaterThan(0);
  });

  it('handles a plain string prompt and an absent one', () => {
    expect(promptCharLength('hello')).toBe(5);
    expect(promptCharLength(undefined)).toBe(0);
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

  /**
   * ARAS-0058 — the gate is stubbed at the BillingService boundary, exactly as
   * the balance was before: this spec is about what `execute()` does with each
   * answer, not about ledger arithmetic. The arithmetic and the concurrency
   * guarantee are proved against a real Postgres in `hold.integration.spec.ts`,
   * where a mock could not fake them.
   */
  async function buildService(opts: {
    enforced: boolean;
    /** What BillingService.openIntent should answer. Defaults to a clean open. */
    intent?: unknown;
    env?: Record<string, string>;
  }) {
    const { validateEnv } = await import('../config/env.schema');
    // Prime the cached config so getConfig() inside execute() sees our flags
    // instead of validating the ambient process env.
    validateEnv({
      ...BASE_ENV,
      ...(opts.env ?? {}),
      BILLING_ENFORCED: opts.enforced ? 'true' : 'false',
    });

    const { ConnectorsService } = await import('../connectors/connectors.service');
    const { BillingService } = await import('./billing.service');

    const prisma = {
      request: { create: vi.fn(async () => ({ id: 'req-1' })) },
      // The persist path is transactional now; a mock without $transaction
      // would model a client that cannot exist.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const billing = new BillingService(prisma as never);

    const openIntent = vi.spyOn(billing, 'openIntent').mockResolvedValue(
      (opts.intent ?? {
        outcome: 'opened',
        intent: { id: 'intent-1', apiKeyId: 'key-1', intentKey: 'k', holdUsd: 0 },
      }) as never,
    );
    const settleIntentInTx = vi.spyOn(billing, 'settleIntentInTx').mockResolvedValue(true);
    const settleInTx = vi.spyOn(billing, 'settleInTx').mockResolvedValue(true);
    const releaseIntent = vi.spyOn(billing, 'releaseIntent').mockResolvedValue(true);

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
      prisma as never,
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
    return { service, connector, openIntent, settleIntentInTx, settleInTx, releaseIntent };
  }

  it('refuses the call when the balance cannot cover the estimate', async () => {
    const { service, connector } = await buildService({
      enforced: true,
      intent: { outcome: 'insufficient', balanceUsd: '0', requiredUsd: '0.01' },
    });

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
    const { service, connector } = await buildService({ enforced: true });

    const response = await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');

    expect(response.status).toBe('success');
    expect(connector.execute).toHaveBeenCalledTimes(1);
  });

  it('does not gate at all while BILLING_ENFORCED is off', async () => {
    // The dark-ship guarantee: a zero balance must NOT break a live caller
    // until an operator opts in.
    const { service, connector, openIntent } = await buildService({ enforced: false });

    const response = await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');

    expect(response.status).toBe('success');
    expect(connector.execute).toHaveBeenCalledTimes(1);
    // And it does not so much as touch the intent table: this is the path
    // essentially all production traffic takes today, and it must stay free.
    expect(openIntent).not.toHaveBeenCalled();
  });

  // ─── ARAS-0058 ────────────────────────────────────────────────────────────

  it('RESERVES the estimate rather than merely reading the balance', async () => {
    const { service, openIntent } = await buildService({ enforced: true });

    await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');

    expect(openIntent).toHaveBeenCalledTimes(1);
    const call = openIntent.mock.calls[0][0] as { holdUsd: number; apiKeyId: string };
    expect(call.apiKeyId).toBe('key-1');
    expect(call.holdUsd).toBeGreaterThan(0);
  });

  it('settles against the intent, inside the transaction that writes the Request row', async () => {
    const { service, settleIntentInTx, settleInTx } = await buildService({ enforced: true });

    await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');

    expect(settleIntentInTx).toHaveBeenCalledTimes(1);
    expect(settleInTx).not.toHaveBeenCalled();
    const [, params] = settleIntentInTx.mock.calls[0] as [
      unknown,
      { amountUsd: number; requestId: string },
    ];
    // The MEASURED cost, never the estimate.
    expect(params.amountUsd).toBe(0.001);
    expect(params.requestId).toBe('req-1');
  });

  it('still records spend on the ledger while enforcement is off', async () => {
    // Dark-ship: the ledger records from the moment billing shipped, which is
    // what makes enabling enforcement later a switch rather than a migration.
    const { service, settleInTx, settleIntentInTx } = await buildService({ enforced: false });

    await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');

    expect(settleInTx).toHaveBeenCalledTimes(1);
    expect(settleIntentInTx).not.toHaveBeenCalled();
  });

  it('folds max_tokens into the amount it reserves', async () => {
    const { service, openIntent } = await buildService({ enforced: true });

    await service.execute(
      'groq',
      { prompt: 'hello', model: 'llama', extra: { max_tokens: 64_000 } },
      'key-1',
    );
    const withMax = (openIntent.mock.calls[0][0] as { holdUsd: number }).holdUsd;

    openIntent.mockClear();
    await service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1');
    const withoutMax = (openIntent.mock.calls[0][0] as { holdUsd: number }).holdUsd;

    expect(withMax).toBeGreaterThan(withoutMax);
  });

  it('refuses a request whose estimate exceeds the per-request ceiling', async () => {
    // A balance check limits the TOTAL spend and says nothing about how much a
    // single call may burn — and max_tokens, which is what makes a call
    // expensive, is chosen by the caller.
    const { service, connector, openIntent } = await buildService({
      enforced: true,
      env: { BILLING_MAX_REQUEST_COST_USD: '0.001' },
    });

    const response = await service.execute(
      'groq',
      { prompt: 'hello', model: 'llama', extra: { max_tokens: 1_000_000 } },
      'key-1',
    );

    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('request_cost_limit_exceeded');
    expect(response.error?.retryable).toBe(false);
    expect(connector.execute).not.toHaveBeenCalled();
    // Refused before anything was reserved, let alone dispatched.
    expect(openIntent).not.toHaveBeenCalled();
  });

  it('replays a completed intent without calling the provider again', async () => {
    const stored = {
      id: 'r1',
      connector: 'groq',
      model: 'llama',
      result: 'the first answer',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.001 },
      latencyMs: 5,
      status: 'success',
    };
    const { service, connector, settleIntentInTx } = await buildService({
      enforced: true,
      intent: { outcome: 'replay', response: stored, requestId: 'req-1' },
    });

    const response = await service.execute(
      'groq',
      { prompt: 'hello', model: 'llama', idempotencyKey: 'client-key-1' },
      'key-1',
    );

    expect(response).toEqual(stored);
    // One provider call and one ledger row, however many times the client
    // re-POSTs — which is the entire point of threading the header through.
    expect(connector.execute).not.toHaveBeenCalled();
    expect(settleIntentInTx).not.toHaveBeenCalled();
  });

  it('opens an intent for an idempotency key even while enforcement is off', async () => {
    // The hold is billing's; the replay guarantee is the caller's. Gating the
    // second on BILLING_ENFORCED would mean a client asking for at-most-once
    // silently did not get it.
    const { service, openIntent } = await buildService({ enforced: false });

    await service.execute(
      'groq',
      { prompt: 'hello', model: 'llama', idempotencyKey: 'client-key-1' },
      'key-1',
    );

    expect(openIntent).toHaveBeenCalledTimes(1);
    const call = openIntent.mock.calls[0][0] as { holdUsd: number; clientSupplied: boolean };
    expect(call.clientSupplied).toBe(true);
    // Nothing is reserved while enforcement is off — there is no balance to
    // reserve against and refusing would break every current caller.
    expect(call.holdUsd).toBe(0);
  });

  it('reports a key reused with a different payload instead of replaying the first', async () => {
    const { service, connector } = await buildService({
      enforced: true,
      intent: { outcome: 'payload_mismatch' },
    });

    const response = await service.execute(
      'groq',
      { prompt: 'a different prompt', model: 'llama', idempotencyKey: 'client-key-1' },
      'key-1',
    );

    expect(response.error?.type).toBe('idempotency_key_reused');
    expect(response.error?.retryable).toBe(false);
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it('tells a caller to wait when the first request under the key is still running', async () => {
    const { service, connector } = await buildService({
      enforced: true,
      intent: { outcome: 'in_flight' },
    });

    const response = await service.execute(
      'groq',
      { prompt: 'hello', model: 'llama', idempotencyKey: 'client-key-1' },
      'key-1',
    );

    expect(response.error?.type).toBe('idempotency_conflict');
    // The one retryable idempotency outcome: the answer genuinely may exist
    // shortly.
    expect(response.error?.retryable).toBe(true);
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it('releases the reservation when the dispatch throws', async () => {
    const { service, connector, releaseIntent } = await buildService({ enforced: true });
    connector.execute.mockRejectedValue(new Error('provider exploded'));

    await expect(
      service.execute('groq', { prompt: 'hello', model: 'llama' }, 'key-1'),
    ).rejects.toThrow('provider exploded');

    // A hold nobody releases is a customer's money frozen until the sweep. The
    // sweep is the backstop for a process that DIES, not the normal path for
    // one that merely fails.
    expect(releaseIntent).toHaveBeenCalledTimes(1);
  });

  it('never forwards the idempotency key to the provider', async () => {
    const { service, connector } = await buildService({ enforced: true });

    await service.execute(
      'groq',
      { prompt: 'hello', model: 'llama', idempotencyKey: 'client-key-1' },
      'key-1',
    );

    const dispatched = connector.execute.mock.calls[0][0] as Record<string, unknown>;
    // It names the INTENT, not the content. Two requests differing only in this
    // field have to be byte-identical on the wire.
    expect(dispatched).not.toHaveProperty('idempotencyKey');
  });
});
