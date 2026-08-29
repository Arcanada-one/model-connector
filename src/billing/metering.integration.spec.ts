/**
 * ARAS-0058 — the falsifier, run for real.
 *
 * The stream's success condition is not a green unit suite. It is:
 *
 *     SELECT sum(amount_usd) FROM credits_ledger WHERE entry_type='charge'
 *
 * becoming NON-ZERO after a metered request. In production that sum was
 * 0.000000 across four charges while 24 gifts had put $10,800 on 23 keys —
 * enforcement was live, the balance could never be drawn down, and no unit test
 * could have noticed, because every one of them would have asserted a mock.
 *
 * So this test runs the whole chain against a real Postgres: a connector that
 * reports token counts and no cost (groq's exact shape), a real catalogue row,
 * the real `CatalogRepository`, the real `BillingService`, real `Request` and
 * `credits_ledger` writes — and then executes the falsifier query itself.
 *
 * What it does NOT do is call a live provider. It stands in for the provider
 * response, not for the money: everything downstream of the HTTP call is the
 * production code path. Proving the last inch needs a credentialled PAID model,
 * which is an operator action (see the stream notes).
 *
 * Requires DATABASE_URL pointing at a schema-synced database:
 *   pnpm test:integration
 */

import { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { CatalogRepository } from '../connectors/catalog.repository';
import { OutputGuardMiddleware } from '../connectors/output-guard/output-guard.middleware';
import type { IConnector } from '../connectors/interfaces/connector.interface';
import type { MetricsService } from '../metrics/metrics.service';
import type { ModalityCatalogService } from '../connectors/modality-catalog.service';

const prisma = new PrismaService();
const billing = new BillingService(prisma);
const catalogRepo = new CatalogRepository(prisma);

// Every billing integration spec shares one database and vitest 4 runs the
// files in parallel, so each one needs a key nothing else touches — otherwise
// a sibling's `reset()` lands mid-test and surfaces as impossible arithmetic
// in a file nobody edited. `2222…` belongs to gift.integration.spec.ts.
const KEY_ID = '44444444-4444-4444-8444-444444444444';
const CONNECTOR = 'groq';
const PRICED_MODEL = 'aras-0058-priced-model';
const UNPRICED_MODEL = 'aras-0058-uncatalogued-model';
const DELISTED_MODEL = 'aras-0058-delisted-model';

// USD per 1M tokens — Groq's published tariff for llama-3.3-70b-versatile.
const INPUT_PER_MTOK = 0.59;
const OUTPUT_PER_MTOK = 0.79;
const INPUT_TOKENS = 100_000;
const OUTPUT_TOKENS = 50_000;
const EXPECTED_USD = (INPUT_TOKENS * INPUT_PER_MTOK + OUTPUT_TOKENS * OUTPUT_PER_MTOK) / 1_000_000; // 0.0985

/** A groq-shaped connector: real token counts, no cost — the bug's shape. */
function connectorReporting(model: string): IConnector {
  return {
    name: CONNECTOR,
    type: 'api',
    execute: vi.fn().mockResolvedValue({
      id: 'resp-1',
      connector: CONNECTOR,
      model,
      result: 'ok',
      usage: {
        inputTokens: INPUT_TOKENS,
        outputTokens: OUTPUT_TOKENS,
        totalTokens: INPUT_TOKENS + OUTPUT_TOKENS,
        costUsd: 0,
      },
      latencyMs: 42,
      status: 'success',
    }),
    getStatus: vi.fn(),
    getCapabilities: vi.fn().mockReturnValue({
      name: CONNECTOR,
      type: 'api',
      models: [model],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    }),
  } as unknown as IConnector;
}

function buildService(connector: IConnector): ConnectorsService {
  const service = new ConnectorsService(
    { add: vi.fn() } as unknown as Queue,
    prisma,
    { record: vi.fn(), getAll: vi.fn().mockReturnValue({}) } as unknown as MetricsService,
    new OutputGuardMiddleware({ enabled: false, maxRetries: 0, timeoutMs: 1_000 }),
    { getEntries: () => [], getFilteredEntries: () => [] } as unknown as ModalityCatalogService,
    catalogRepo,
    null,
    undefined,
    undefined,
    billing,
  );
  service.register(connector);
  return service;
}

/**
 * The literal falsifier, scoped to this test's key so it cannot read stray data.
 *
 * NOTE the sign. `credits_ledger.amount_usd` is signed — "positive credits the
 * account, negative debits it" — so a charge is NEGATIVE and this sum runs down
 * from zero rather than up. The production reading that opened this stream was
 * exactly `0.000000` across four charges; the property being proved is that it
 * moves OFF zero, not that it goes up.
 */
async function chargeTotalUsd(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ sum: string | null }>>`
    SELECT sum(amount_usd)::text AS sum
      FROM credits_ledger
     WHERE entry_type = 'charge' AND api_key_id = ${KEY_ID}
  `;
  return Number(rows[0]?.sum ?? 0);
}

/**
 * The charge must ALREADY exist when `execute()` resolves.
 *
 * This used to poll, because settlement was a fire-and-forget
 * `logRequest(...).catch(...)` and the row landed some time after the caller
 * had its answer. ARAS-0058 (#96) closed that window: `persistAndSettle` writes
 * the `Request` row and the ledger row in one awaited transaction, so a poll
 * here would now hide the very regression it was written to tolerate — a retry
 * loop passes just as happily against a settle that has gone back to being
 * asynchronous. Asserting synchronously is the stronger statement, and it is
 * the one the durability fix is entitled to.
 */
async function expectSettled(): Promise<void> {
  const count = await prisma.creditsLedger.count({
    where: { apiKeyId: KEY_ID, entryType: 'charge' },
  });
  if (count === 0) {
    throw new Error(
      'no charge was settled by the time execute() resolved — the settle path is ' +
        'no longer transactional with the response',
    );
  }
}

async function reset(): Promise<void> {
  await prisma.creditsLedger.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsBalance.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.request.deleteMany({ where: { apiKeyId: KEY_ID } });
}

beforeAll(async () => {
  process.env.PROVIDER_ACCESS = '';
  await prisma.apiKey.upsert({
    where: { id: KEY_ID },
    create: { id: KEY_ID, name: 'aras-0058-meter', keyHash: `hash-${KEY_ID}` },
    update: {},
  });
  const now = new Date();
  await prisma.modelCatalog.upsert({
    where: { connector_model: { connector: CONNECTOR, model: PRICED_MODEL } },
    create: {
      connector: CONNECTOR,
      model: PRICED_MODEL,
      modality: 'chat',
      status: 'online',
      lastChecked: now,
      inputPerMTok: INPUT_PER_MTOK,
      outputPerMTok: OUTPUT_PER_MTOK,
      tier: 'paid',
      free: false,
      lastSeen: now,
      observedAt: now,
    },
    update: { inputPerMTok: INPUT_PER_MTOK, outputPerMTok: OUTPUT_PER_MTOK, tier: 'paid' },
  });
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await prisma.modelCatalog.deleteMany({
    where: { connector: CONNECTOR, model: { in: [PRICED_MODEL, UNPRICED_MODEL, DELISTED_MODEL] } },
  });
  await prisma.apiKey.deleteMany({ where: { id: KEY_ID } });
  await prisma.$disconnect();
});

describe('ARAS-0058 — usage becomes money in the ledger', () => {
  it('moves the charge total off zero after a metered request', async () => {
    await billing.credit({ apiKeyId: KEY_ID, amountUsd: '10', idempotencyKey: 'aras-0058-topup' });

    // The state the finding described: charges exist, and they sum to nothing.
    expect(await chargeTotalUsd()).toBe(0);

    const service = buildService(connectorReporting(PRICED_MODEL));
    const response = await service.execute(CONNECTOR, { prompt: 'meter me' }, KEY_ID);
    await expectSettled();

    // THE FALSIFIER.
    const total = await chargeTotalUsd();
    expect(total).not.toBe(0);
    // Signed ledger: a charge debits, so the sum goes negative by the cost.
    expect(total).toBeLessThan(0);
    expect(Math.abs(total)).toBeCloseTo(EXPECTED_USD, 6);

    // ...and the same number all the way down.
    expect(response.usage.costUsd).toBeCloseTo(EXPECTED_USD, 6);

    const request = await prisma.request.findFirst({ where: { apiKeyId: KEY_ID } });
    expect(Number(request!.costUsd)).toBeCloseTo(EXPECTED_USD, 6);
    expect(request!.costSource).toBe('catalog');

    const balance = await billing.balance(KEY_ID);
    expect(balance.toNumber()).toBeCloseTo(10 - EXPECTED_USD, 6);
  });

  it('treats a delisted model as unpriced rather than pricing it from a tombstone', async () => {
    // An `absent` row is the catalogue's tombstone for a model the provider
    // stopped listing; its tariff is last-known, not current. The pre-call gate
    // reads through `findAll()` (non-absent only) and would price this at the
    // unknown-model floor, so the meter agrees with it.
    const now = new Date();
    await prisma.modelCatalog.upsert({
      where: { connector_model: { connector: CONNECTOR, model: DELISTED_MODEL } },
      create: {
        connector: CONNECTOR,
        model: DELISTED_MODEL,
        modality: 'chat',
        status: 'offline',
        lastChecked: now,
        inputPerMTok: INPUT_PER_MTOK,
        outputPerMTok: OUTPUT_PER_MTOK,
        tier: 'paid',
        free: false,
        absent: true,
        lastSeen: now,
        observedAt: now,
      },
      update: { absent: true },
    });
    await billing.credit({
      apiKeyId: KEY_ID,
      amountUsd: '10',
      idempotencyKey: 'aras-0058-topup-3',
    });

    const service = buildService(connectorReporting(DELISTED_MODEL));
    await service.execute(CONNECTOR, { prompt: 'meter me' }, KEY_ID);
    await expectSettled();

    const request = await prisma.request.findFirst({ where: { apiKeyId: KEY_ID } });
    expect(request!.costSource).toBe('unpriced');
    expect(Number(request!.costUsd)).toBe(0);
  });

  it('charges an uncatalogued model nothing, and says so in the ledger', async () => {
    await billing.credit({
      apiKeyId: KEY_ID,
      amountUsd: '10',
      idempotencyKey: 'aras-0058-topup-2',
    });

    const service = buildService(connectorReporting(UNPRICED_MODEL));
    await service.execute(CONNECTOR, { prompt: 'meter me' }, KEY_ID);
    await expectSettled();

    const request = await prisma.request.findFirst({ where: { apiKeyId: KEY_ID } });
    expect(request!.costSource).toBe('unpriced');

    const ledger = await prisma.creditsLedger.findFirst({
      where: { apiKeyId: KEY_ID, entryType: 'charge' },
    });
    // A $0 charge that means "we could not price this" must not read the same
    // as one that means "this model is free".
    expect(ledger!.reason).toBe('model-request:unpriced');
    expect(Number(ledger!.amountUsd)).toBe(0);
  });
});
