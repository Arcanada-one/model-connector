/**
 * A2-299b / DEC-AUP-0050 R2 — the customer pays $0 on the INTENT path too.
 *
 * `aborted-attempt-is-our-cost.spec.ts` proved R2 against `settleInTx`, the
 * branch a caller reaches when billing is dark and no idempotency key was sent.
 * Its harness stubs `openRequestIntent` to `null`, so `persistAndSettle`'s OTHER
 * branch — `settleIntentInTx`, the one every enforced or idempotent request
 * takes — was never executed by any test in the repository.
 *
 * Measured, not inferred. Reverting the intent branch alone to the pre-decision
 * expression:
 *
 *     await this.billing.settleIntentInTx(tx, {
 *       intent,
 *   -   amountUsd: customerChargeUsd,
 *   +   amountUsd: response.usage.costUsd,
 *
 * left the WHOLE SUITE green — 219 files, 3272 tests, 3272 passed. The
 * non-intent mutant is caught; this one was not. So a client sending
 * `Idempotency-Key`, or any client at all once `BILLING_ENFORCED` is switched
 * on, would have been charged the estimate for an attempt it never received an
 * answer to, and CI would have said nothing. That is exactly what DEC-AUP-0050
 * R2 forbids, and the branch that will carry essentially all future traffic.
 *
 * WHY A SEPARATE FILE. This block has to prime the validated config
 * (`BILLING_ENFORCED=true`) to reach the enforced path, which means
 * `vi.resetModules()` plus dynamic imports. The sibling spec drives a real
 * `BaseApiConnector` through a statically imported `getConfig()`; resetting the
 * module registry underneath it would change what that file measures. The two
 * files are two halves of R2 and each says so.
 *
 * WHY AN IN-MEMORY DATABASE RATHER THAN A MOCKED BillingService. The A2-287
 * lesson, and the one A2-299's own mutant 3 re-learned: a fixture written by the
 * same hand as the code can agree with the bug. Asserting on
 * `settleIntentInTx.mock.calls[0][0].amountUsd` would only re-read the argument
 * the production line just computed. So the REAL `BillingService.settleIntentInTx`
 * runs here, against a store that behaves like the ledger's actual constraints,
 * and the assertions read what the REAL component WROTE: the intent row's final
 * state, the ledger rows, and above all the customer's BALANCE. A balance that
 * does not move is not a restatement of any expression in the production code.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/** 40 000 chars / 4 chars-per-token = 10 000 estimated input tokens. */
const PROMPT = 'x'.repeat(40_000);
const PRICED = 'abort-priced-model';
const INPUT_PER_MTOK = 1.74;
/** 10 000 tokens at 1.74/MTok. */
const OUR_COST = 0.0174;
const OPENING_BALANCE = 5;

/** Minimal env the schema accepts, mirroring credit-gate.spec.ts. */
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

interface IntentRow {
  id: string;
  apiKeyId: string;
  intentKey: string;
  clientSupplied: boolean;
  payloadFingerprint: string;
  holdUsd: unknown;
  state: string;
  expiresAt: Date;
  requestId?: string | null;
  response?: unknown;
  completedAt?: Date | null;
}

interface LedgerRow {
  apiKeyId: string;
  amountUsd: unknown;
  idempotencyKey: string;
  requestId?: string;
  reason: string;
  entryType: string;
}

/**
 * The ledger, the balance and the intent table, in memory.
 *
 * Only the operations the settle path actually performs, and each one behaving
 * the way the real schema does where that matters to the assertions:
 *
 *   - `requestIntent.updateMany` honours its `where.state` guard, because that
 *     guard IS the anti-double-charge control and a double that ignored it would
 *     make the concurrency story untestable;
 *   - `creditsLedger.create` enforces the global unique index on
 *     `idempotencyKey`, so a replayed charge is rejected here as it would be by
 *     Postgres;
 *   - the balance is a NUMBER that moves, so "the customer was charged" is
 *     observable as a fact about their money rather than as an argument value.
 *
 * `Prisma.Decimal` arrives from the production code; it is converted with
 * `Number(...)` only at the assertion boundary.
 */
function memoryDb(openingBalance = OPENING_BALANCE) {
  const intents = new Map<string, IntentRow>();
  const ledger: LedgerRow[] = [];
  const requests: Record<string, unknown>[] = [];
  const balances = new Map<string, { balanceUsd: number; heldUsd: number }>([
    ['key-1', { balanceUsd: openingBalance, heldUsd: 0 }],
  ]);
  let seq = 0;

  const db: Record<string, unknown> = {
    requestIntent: {
      create: vi.fn(async ({ data }: { data: Omit<IntentRow, 'id'> }) => {
        // The real unique index on (api_key_id, intent_key) is what turns a
        // repeat of an idempotency key into a REPLAY rather than a second
        // dispatch: `openIntent` catches P2002 and resolves it. A double that
        // let the insert through would make the replay path unreachable, so it
        // rejects here exactly as Postgres would.
        for (const row of intents.values()) {
          if (row.apiKeyId === data.apiKeyId && row.intentKey === data.intentKey) {
            throw new Prisma.PrismaClientKnownRequestError(
              'Unique constraint failed on the fields: (`api_key_id`,`intent_key`)',
              { code: 'P2002', clientVersion: 'test' },
            );
          }
        }
        const row: IntentRow = { id: `intent-${++seq}`, ...data };
        intents.set(row.id, row);
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; state?: string | { in: string[] } };
          data: Record<string, unknown>;
        }) => {
          const row = intents.get(where.id);
          if (!row) return { count: 0 };
          // The state guard is the concurrency control; honour it.
          const want = where.state;
          if (typeof want === 'string' && row.state !== want) return { count: 0 };
          if (want && typeof want === 'object' && !want.in.includes(row.state)) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { apiKeyId_intentKey: { apiKeyId: string; intentKey: string } };
        }) => {
          const { apiKeyId, intentKey } = where.apiKeyId_intentKey;
          for (const row of intents.values()) {
            if (row.apiKeyId === apiKeyId && row.intentKey === intentKey) return row;
          }
          return null;
        },
      ),
    },
    creditsLedger: {
      create: vi.fn(async ({ data }: { data: LedgerRow }) => {
        // The real unique index is global on `idempotencyKey`. Rejecting here is
        // what makes a double-charge a database error rather than a silent second
        // row, and the settle path's behaviour depends on that.
        if (ledger.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          throw new Error(
            `UNIQUE violation on credits_ledger.idempotency_key=${data.idempotencyKey}`,
          );
        }
        ledger.push(data);
        return data;
      }),
    },
    creditsBalance: {
      findUnique: vi.fn(async ({ where }: { where: { apiKeyId: string } }) => {
        const row = balances.get(where.apiKeyId);
        if (!row) return null;
        return {
          balanceUsd: new Prisma.Decimal(row.balanceUsd),
          heldUsd: new Prisma.Decimal(row.heldUsd),
        };
      }),
      upsert: vi.fn(async ({ where }: { where: { apiKeyId: string } }) => {
        if (!balances.has(where.apiKeyId)) {
          balances.set(where.apiKeyId, { balanceUsd: 0, heldUsd: 0 });
        }
        return balances.get(where.apiKeyId);
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { apiKeyId: string };
          data: { balanceUsd?: { decrement?: unknown } };
        }) => {
          const row = balances.get(where.apiKeyId)!;
          const dec = data.balanceUsd?.decrement;
          if (dec !== undefined) row.balanceUsd -= Number(dec);
          return row;
        },
      ),
    },
    request: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        requests.push(data);
        return { id: `req-${requests.length}` };
      }),
    },
    firstDispatchObservation: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    /** `SELECT balance_usd ... FOR UPDATE` — the only $queryRaw on this path. */
    $queryRaw: vi.fn(async () => [{ balance_usd: balances.get('key-1')!.balanceUsd }]),
    /** The two hold statements. Both are raw SQL; tell them apart by text. */
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      const row = balances.get('key-1')!;
      if (sql.includes('held_usd = held_usd +')) {
        const amount = Number(values[0]);
        // The real statement's WHERE clause: refuse when the spendable balance
        // cannot cover the hold. Returning 1 unconditionally would make an
        // over-budget hold untestable.
        if (row.balanceUsd - row.heldUsd < amount) return 0;
        row.heldUsd += amount;
        return 1;
      }
      if (sql.includes('GREATEST')) {
        row.heldUsd = Math.max(row.heldUsd - Number(values[0]), 0);
        return 1;
      }
      throw new Error(`unexpected $executeRaw: ${sql}`);
    }),
  };

  return { db, intents, ledger, requests, balances };
}

/**
 * A connector whose attempt was ABORTED: it reports input tokens it estimated
 * from the prompt it had already handed over, flagged `estimated`, exactly as
 * `BaseApiConnector`'s abort branch does (base-api.connector.ts, `isAbort`).
 *
 * `estimated` is the ONLY difference between this and `meteredConnector` below,
 * which is what makes the pair a control: same tokens, same tariff, same
 * timeout-shaped envelope.
 */
function abortedConnector(classifyErrorAction: (t: string) => object, estimated: boolean) {
  const estimatedTokens = 10_000;
  return {
    name: 'test',
    type: 'api' as const,
    execute: vi.fn().mockResolvedValue({
      id: 'r',
      connector: 'test',
      model: PRICED,
      result: '',
      usage: {
        inputTokens: estimatedTokens,
        outputTokens: 0,
        totalTokens: estimatedTokens,
        costUsd: 0,
        ...(estimated ? { estimated: true as const } : {}),
      },
      latencyMs: 400,
      status: 'timeout',
      error: { type: 'timeout', message: 'aborted', ...classifyErrorAction('timeout') },
    }),
    getStatus: vi.fn().mockResolvedValue({
      name: 'test',
      healthy: true,
      activeJobs: 0,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    }),
    getCapabilities: vi.fn().mockReturnValue({
      name: 'test',
      type: 'api',
      models: [PRICED],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    }),
    resetCircuitBreaker: vi.fn().mockReturnValue([]),
  };
}

describe('A2-299b / DEC-AUP-0050 R2 — the INTENT path charges the customer nothing', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.env.PROVIDER_ACCESS = '';
  });

  /**
   * The enforced dispatch path, end to end, with a REAL `BillingService` over
   * the in-memory store. Enforcement is ON, which is what makes
   * `openRequestIntent` open a real intent and reserve a real hold — and
   * therefore what makes `persistAndSettle` take its `intent` branch.
   */
  async function stand(opts: { estimated: boolean; openingBalance?: number }) {
    const { validateEnv } = await import('../config/env.schema');
    validateEnv({ ...BASE_ENV, BILLING_ENFORCED: 'true' });

    const { ConnectorsService } = await import('./connectors.service');
    const { BillingService } = await import('../billing/billing.service');
    const { OutputGuardMiddleware } = await import('./output-guard/output-guard.middleware');
    const { classifyErrorAction } = await import('./interfaces/connector.interface');
    const intentKeys = await import('../billing/intent');

    const store = memoryDb(opts.openingBalance);
    const billing = new BillingService(store.db as never);

    const service = new ConnectorsService(
      { add: vi.fn() } as never,
      store.db as never,
      { record: vi.fn(), getAll: vi.fn().mockReturnValue({}) } as never,
      new OutputGuardMiddleware({ enabled: false, maxRetries: 3, timeoutMs: 30_000 }),
      { getEntries: () => [], getFilteredEntries: () => [] } as never,
      {
        findAll: vi.fn().mockResolvedValue([
          {
            connector: 'test',
            model: PRICED,
            inputPerMTok: INPUT_PER_MTOK,
            outputPerMTok: 3.48,
            cachedInputPerMTok: null,
            status: 'online',
          },
        ]),
      } as never,
      null,
      undefined,
      undefined,
      billing,
    );
    service.register(abortedConnector(classifyErrorAction, opts.estimated) as never);
    return { service, ...store, intentKeys };
  }

  it('settles the intent at ZERO and leaves the customer balance untouched', async () => {
    const { service, intents, ledger, requests, balances, intentKeys } = await stand({
      estimated: true,
    });

    await service.execute(
      'test',
      { prompt: PROMPT, model: PRICED, idempotencyKey: 'client-key-1' },
      'key-1',
    );

    // The intent branch was genuinely taken: a real intent row exists and the
    // REAL `settleIntentInTx` moved it off `held`.
    expect(intents.size).toBe(1);
    const intent = [...intents.values()][0];
    expect(intent.state).toBe('completed');
    expect(intent.clientSupplied).toBe(true);
    expect(intent.intentKey).toBe('client-key-1');
    expect(intent.requestId).toBe('req-1');
    // The stored response is what makes a replay answer THIS attempt.
    expect(intent.response).toBeDefined();

    // R3 — our cost is on the record, and labelled as ours.
    expect(requests).toHaveLength(1);
    expect(requests[0].costSource).toBe('estimated-input-unbilled');
    expect(Number(requests[0].costUsd)).toBeCloseTo(OUR_COST, 6);

    // R2 — and the CUSTOMER'S MONEY DID NOT MOVE. Read from the balance the
    // real settle path wrote, not from any expression in the service.
    expect(balances.get('key-1')!.balanceUsd).toBe(OPENING_BALANCE);
    // The hold that was reserved before dispatch was given back in full.
    expect(balances.get('key-1')!.heldUsd).toBe(0);

    // One charge row, for zero, findable by name (R3), against the intent's
    // own derived ledger key.
    const charges = ledger.filter((r) => r.entryType === 'charge');
    expect(charges).toHaveLength(1);
    // A charge is posted as a NEGATIVE ledger entry (`chargeInTx` writes
    // `amountUsd.negated()`), so "charged nothing" is a row of magnitude zero.
    // Compared by magnitude so the assertion cannot pass on a sign mistake, and
    // the CONTROL below is what proves it is not vacuous.
    expect(Math.abs(Number(charges[0].amountUsd))).toBe(0);
    expect(charges[0].reason).toContain('estimated-input-unbilled');
    expect(charges[0].idempotencyKey).toBe(intentKeys.ledgerKeyForIntent(intent.id));
    expect(charges[0].requestId).toBe('req-1');
    // Nothing was written off, because nothing was charged.
    expect(ledger.filter((r) => r.entryType === 'uncollectible')).toHaveLength(0);
  });

  it('CONTROL: a provider-METERED cost on the same path DOES debit the balance', async () => {
    // Same tokens, same tariff, same timeout envelope. The only difference is
    // that the provider reported the count, so `estimated` is absent. If this
    // did not move, the test above would be satisfied by a service that charges
    // nobody for anything.
    const { service, requests, ledger, balances } = await stand({ estimated: false });

    await service.execute(
      'test',
      { prompt: PROMPT, model: PRICED, idempotencyKey: 'client-key-2' },
      'key-1',
    );

    expect(requests[0].costSource).toBe('catalog');
    const charges = ledger.filter((r) => r.entryType === 'charge');
    expect(charges).toHaveLength(1);
    expect(Number(charges[0].amountUsd)).toBeCloseTo(-OUR_COST, 6);
    expect(balances.get('key-1')!.balanceUsd).toBeCloseTo(OPENING_BALANCE - OUR_COST, 6);
  });

  it('an intent the sweeper expired mid-flight leaves an UNBILLABLE orphan row', async () => {
    // How the reconciler ever gets to see one of these — measured, not assumed.
    //
    // `settleIntentInTx` charges only if it can move the intent off `held`
    // (`updateMany({where: {state: 'held'}})`); that guard is the anti-double-charge
    // control. If the hold expired while the request was still in flight and the
    // hourly sweep released it, the guard matches nothing, `settleIntentInTx`
    // returns false, and NO ledger row is written — but `persistAndSettle` ignores
    // the return value, so the transaction still commits the `Request` row.
    //
    // The result is precisely the shape `BillingReconcilerService.findUnsettled`
    // hunts for: `costUsd > 0` and no ledger entry. Before DEC-AUP-0050 an aborted
    // attempt recorded `costUsd: 0` and could never appear in that query at all;
    // now it can, which is why the reconciler needed the R2 guard added in
    // `reconciler-unbillable.spec.ts`. The abort case is also the likeliest to hit
    // this window, being by definition the longest-running kind of request.
    const { service, intents, ledger, requests, balances } = await stand({ estimated: true });

    // Stand in for the sweeper: expire the hold after the intent is open and
    // before the settle, which is exactly the window that produces the orphan.
    const connector = (
      service as unknown as { connectors: Map<string, { execute: () => unknown }> }
    ).connectors.get('test')!;
    const dispatch = connector.execute;
    connector.execute = vi.fn(async (...args: unknown[]) => {
      for (const row of intents.values()) row.state = 'expired';
      return (dispatch as (...a: unknown[]) => unknown)(...args);
    }) as never;

    await service.execute(
      'test',
      { prompt: PROMPT, model: PRICED, idempotencyKey: 'client-key-swept' },
      'key-1',
    );

    // The row landed, carrying OUR cost...
    expect(requests).toHaveLength(1);
    expect(requests[0].costSource).toBe('estimated-input-unbilled');
    expect(Number(requests[0].costUsd)).toBeCloseTo(OUR_COST, 6);
    // ...and nothing settled it, so it is an orphan by the reconciler's definition.
    expect(ledger).toHaveLength(0);
    // The customer's balance is still untouched, which is the state the
    // reconciler must not "repair".
    expect(balances.get('key-1')!.balanceUsd).toBe(OPENING_BALANCE);
  });

  it('a REPLAY of the same idempotency key does not charge the estimate either', async () => {
    // The second settlement path the card asks about, reached rather than
    // reasoned about: a client that retries after a timeout with the SAME
    // `Idempotency-Key`. `openIntent`'s insert hits the unique index, and
    // `resolveReplay` answers from the intent's stored response instead of
    // dispatching again.
    //
    // This is the exact double-charge the billing role named in the consilium,
    // and the reason a retry is safe ONLY when the caller sends a key. The
    // replayed envelope still tells the caller what the attempt cost US
    // (`estimated-input-unbilled`, $0.0174) — and the ledger must still hold
    // exactly one row, for zero.
    const { service, intents, ledger, requests, balances } = await stand({ estimated: true });

    const first = await service.execute(
      'test',
      { prompt: PROMPT, model: PRICED, idempotencyKey: 'client-key-retry' },
      'key-1',
    );
    const replayed = await service.execute(
      'test',
      { prompt: PROMPT, model: PRICED, idempotencyKey: 'client-key-retry' },
      'key-1',
    );

    // It really was a replay: the stored response came back, not a new dispatch.
    expect(intents.size).toBe(1);
    expect(requests).toHaveLength(1);
    expect(replayed.usage.costSource).toBe('estimated-input-unbilled');
    expect(replayed.usage.costUsd).toBeCloseTo(OUR_COST, 6);
    expect(replayed.usage.costUsd).toBe(first.usage.costUsd);

    // And the money did not move, once or twice.
    expect(ledger.filter((r) => r.entryType === 'charge')).toHaveLength(1);
    expect(ledger.filter((r) => r.entryType === 'uncollectible')).toHaveLength(0);
    expect(balances.get('key-1')!.balanceUsd).toBe(OPENING_BALANCE);
    expect(balances.get('key-1')!.heldUsd).toBe(0);
  });
});
