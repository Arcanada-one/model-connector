/**
 * A2-425 — a transient upstream stall gets ONE retry, where a retry is provably
 * the same request.
 *
 * Measured by A2-403 on arcana-devs: over 552 `arcana` turns (2026-09-23..27),
 * 27 (4.9 %) took longer than 100 s, independent of prompt size, and a replay
 * of the turn that died (A2-401, HTTP 201 `status: timeout` after 110 s) took
 * 1.4-29.6 s. Since A2-299 every `timeout` carried `retryable: false`, which is
 * terminal for the client, so one stall ended the whole run.
 *
 * Simply flipping the flag back would NOT have fixed it, and this file is the
 * proof: under an `Idempotency-Key` the timed-out attempt was COMPLETED and its
 * response stored, and `arcana` re-dispatches a turn under the same key. The
 * retry would have been answered with a replay of the very timeout it was
 * retrying (test 1's second mutant).
 *
 * Everything below runs against a local HTTP server and a local `sleep`, with
 * the REAL `BillingService` over an in-memory store (copied from
 * aborted-attempt-intent-path.spec.ts, same reasons as given there). The
 * assertions read what the real components WROTE: the intent row's state, the
 * provider hit counter, the ledger, the balance.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { Prisma } from '@prisma/client';
import { BaseApiConnector, ParsedApiOutput } from './base-api.connector';
import { BaseCliConnector, ParsedCliOutput } from './base-cli.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
} from './interfaces/connector.interface';
import { ConnectorsService } from './connectors.service';
import { BillingService } from '../billing/billing.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import { validateEnv } from '../config/env.schema';

const OPENING_BALANCE = 5;
const BUDGET_MS = 150;
const MODEL = 'stall-model';

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
  // Model Connector's own loop must not be what makes the turn continue: with
  // one server-side attempt, every provider call below is a CLIENT dispatch.
  CONNECTOR_MAX_RETRIES: '0',
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

// ---------------------------------------------------------------------------
// The provider: a local server whose n-th request either hangs (accepts and
// never answers — a real `AbortSignal.timeout()` fires on a real `fetch`) or
// answers. `hits` is the ground truth for "did the retry reach the provider".
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;
let script: Array<'hang' | 'answer'> = [];
let hits = 0;

beforeAll(async () => {
  validateEnv(BASE_ENV);
  server = createServer((req, res) => {
    const step = script[hits] ?? 'hang';
    hits += 1;
    req.resume();
    if (step === 'answer') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: `answer-${hits}` }));
    }
    // 'hang': accept, never respond.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

class StallingApiConnector extends BaseApiConnector {
  readonly name = 'stall-api';
  constructor(private readonly url: string) {
    super();
  }
  protected getTimeout(): number {
    return 300_000;
  }
  protected getBaseUrl(): string {
    return this.url;
  }
  protected buildRequestUrl(): string {
    return `${this.url}/v1/complete`;
  }
  protected buildRequestBody(request: ConnectorRequest): unknown {
    return { input: request.prompt };
  }
  protected parseResponse(data: unknown): ParsedApiOutput {
    return {
      text: (data as { text: string }).text,
      model: MODEL,
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0,
      isError: false,
    };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: [MODEL],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 600_000,
    };
  }
}

/** A CLI lane that outlives its budget: `sleep 30` killed at 150 ms. */
class SleepingCliConnector extends BaseCliConnector {
  readonly name = 'stall-cli';
  protected getTimeout(): number {
    return 300_000;
  }
  protected getBinaryPath(): string {
    return '/bin/sleep';
  }
  protected buildArgs(): string[] {
    return ['30'];
  }
  protected parseOutput(stdout: string): ParsedCliOutput {
    return {
      text: stdout.trim(),
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'cli',
      models: [MODEL],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 600_000,
    };
  }
}

function stand(steps: Array<'hang' | 'answer'>) {
  script = steps;
  hits = 0;
  const store = memoryDb();
  const billing = new BillingService(store.db as never);
  const service = new ConnectorsService(
    { add: vi.fn() } as never,
    store.db as never,
    { record: vi.fn(), getAll: vi.fn().mockReturnValue({}) } as never,
    new OutputGuardMiddleware({ enabled: false, maxRetries: 3, timeoutMs: 30_000 }),
    { getEntries: () => [], getFilteredEntries: () => [] } as never,
    { findAll: vi.fn().mockResolvedValue([]) } as never,
    null,
    undefined,
    undefined,
    billing,
  );
  service.register(new StallingApiConnector(baseUrl) as never);
  service.register(new SleepingCliConnector() as never);
  return { service, ...store };
}

function send(
  service: ConnectorsService,
  connector: string,
  idempotencyKey?: string,
): Promise<ConnectorResponse> {
  return service.execute(
    connector,
    {
      prompt: 'the same turn, byte for byte',
      model: MODEL,
      timeout: BUDGET_MS,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    'key-1',
  );
}

/**
 * One `arcana` turn, reduced to the two rules of `crates/core/src/agent_loop.rs`
 * that decide it: an envelope's `retryable` is `is_transient()`
 * (`connector.rs`, `Self::Logical { retryable, .. } => *retryable`), and a
 * turn re-dispatches the SAME payload under the SAME key up to
 * `DEFAULT_CONNECTOR_RETRY_LIMIT` = 2 times. Returns whether the run goes on.
 */
async function arcanaTurn(service: ConnectorsService, connector: string, key?: string) {
  let response = await send(service, connector, key);
  let retries = 0;
  while (response.status !== 'success') {
    if (!response.error?.retryable || retries >= 2) return { continued: false, response };
    retries += 1;
    response = await send(service, connector, key);
  }
  return { continued: true, response };
}

describe('A2-425 — a transient timeout is retried once, where a retry is the same request', () => {
  it('RED CONTROL: one stall on the API lane under a key → the turn continues on the retry', async () => {
    const { service, intents, ledger, requests, balances } = stand(['hang', 'answer']);

    const first = await send(service, 'stall-api', 'turn-1');
    expect(first.status).toBe('timeout');
    expect(first.error?.type).toBe('timeout');
    expect(first.error?.retryable).toBe(true);
    expect(first.error?.recommendation).toBe('retry');
    // Recorded (our cost, R3) but NOT stored for replay and NOT charged (R2).
    const intent = [...intents.values()][0];
    expect(intent.state).toBe('released');
    expect(intent.response).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('timeout');
    expect(ledger.filter((r) => r.entryType === 'charge')).toHaveLength(0);
    expect(balances.get('key-1')!.heldUsd).toBe(0);

    // The repeat under the SAME key reaches the provider — hit 2 — and answers.
    const second = await send(service, 'stall-api', 'turn-1');
    expect(hits).toBe(2);
    expect(second.status).toBe('success');
    expect(second.result).toBe('answer-2');
    expect(intent.state).toBe('completed');
    expect(balances.get('key-1')!.balanceUsd).toBe(OPENING_BALANCE);
  });

  it('RED CONTROL, end to end: the same stall no longer ends an arcana run', async () => {
    const { service } = stand(['hang', 'answer']);
    const turn = await arcanaTurn(service, 'stall-api', 'turn-1');
    expect(turn.continued).toBe(true);
    expect(turn.response.result).toBe('answer-2');
    expect(hits).toBe(2);
  });

  it('a second timeout under the same key is final, and a third repeat is a replay, not a dispatch', async () => {
    const { service, intents } = stand(['hang', 'hang', 'answer']);

    const turn = await arcanaTurn(service, 'stall-api', 'turn-1');
    expect(turn.continued).toBe(false);
    expect(turn.response.error?.retryable).toBe(false);
    expect(turn.response.error?.recommendation).toBe('abort');
    expect(hits).toBe(2);
    expect([...intents.values()][0].state).toBe('completed');

    // A client that ignores `abort` buys nothing more: the stored final answer
    // is replayed and the provider is not called a third time.
    const again = await send(service, 'stall-api', 'turn-1');
    expect(hits).toBe(2);
    expect(again.error?.retryable).toBe(false);
  });

  it('without an Idempotency-Key nothing ties a repeat to this attempt → still abort', async () => {
    const { service } = stand(['hang', 'answer']);
    const turn = await arcanaTurn(service, 'stall-api');
    expect(turn.continued).toBe(false);
    expect(turn.response.status).toBe('timeout');
    expect(turn.response.error?.recommendation).toBe('abort');
    expect(hits).toBe(1);
  });

  it('RED CONTROL, the other way: a CLI lane may have run tools → not proven idempotent → abort', async () => {
    const { service, intents, requests } = stand([]);
    // Asserted on the FIRST envelope, not on how the turn ends: a granted retry
    // would also end in abort (the second timeout is final), so the end state
    // alone cannot tell "never retried" from "retried once" — measured, the
    // weaker form of this test survived the mutant that grants the CLI lane.
    const first = await send(service, 'stall-cli', 'turn-1');
    expect(first.status).toBe('timeout');
    expect(first.error?.retryable).toBe(false);
    expect(first.error?.recommendation).toBe('abort');
    expect([...intents.values()][0].state).toBe('completed');

    // And the client's repeat is a replay, not a second spawn of the agent.
    const again = await send(service, 'stall-cli', 'turn-1');
    expect(again.error?.retryable).toBe(false);
    expect(requests).toHaveLength(1);
  });
});
