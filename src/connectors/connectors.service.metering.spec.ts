/**
 * ARAS-0058 — the money meter, wired end to end through the service.
 *
 * `measured-cost.spec.ts` proves the arithmetic. This proves the WIRING, which
 * is where the bug actually lived: the tokens were always there, the price was
 * always there, and nothing joined them, so `Request.costUsd` and every
 * `credits_ledger` charge came out $0.000000.
 *
 * The assertions therefore follow the money rather than the function: what
 * lands on the request row, and what amount the ledger is asked to debit.
 *
 * ARAS-0058 (#96) then made that settle TRANSACTIONAL, so the debit now arrives
 * via `settleInTx` / `settleIntentInTx` inside the same `$transaction` as the
 * `Request` row. The money assertions below are unchanged; only the seam they
 * observe moved, which is the point — the amount and its provenance must commit
 * together or not at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';

import { ConnectorsService } from './connectors.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import type { CatalogPricingRow, CatalogRepositoryLike } from './catalog.repository';
import type { IConnector } from './interfaces/connector.interface';
import type { PrismaService } from '../prisma/prisma.service';
import type { BillingService } from '../billing/billing.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { ModalityCatalogService } from './modality-catalog.service';

// Groq's published tariff for llama-3.3-70b-versatile, USD per 1M tokens.
const GROQ_PAID_ROW: CatalogPricingRow = {
  inputPerMTok: 0.59,
  outputPerMTok: 0.79,
  tier: 'paid',
};

// What every groq chat model actually looks like in the catalogue today:
// CONN-1672 suppresses the reported list price because the free tier is
// genuinely $0, so the row carries tier=free with NULL tariffs.
const GROQ_FREE_ROW: CatalogPricingRow = {
  inputPerMTok: null,
  outputPerMTok: null,
  tier: 'free',
};

/** A groq-shaped connector: reports token counts, reports no cost. */
function groqShapedConnector(usage: {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}): IConnector {
  return {
    name: 'groq',
    type: 'api',
    execute: vi.fn().mockResolvedValue({
      id: 'resp-1',
      connector: 'groq',
      model: 'llama-3.3-70b-versatile',
      result: 'ok',
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        costUsd: usage.costUsd ?? 0,
      },
      latencyMs: 42,
      status: 'success',
    }),
    getStatus: vi.fn(),
    getCapabilities: vi.fn().mockReturnValue({
      name: 'groq',
      type: 'api',
      models: ['llama-3.3-70b-versatile'],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    }),
  } as unknown as IConnector;
}

describe('ConnectorsService — ARAS-0058 metering', () => {
  const created: Array<Record<string, unknown>> = [];
  const settled: Array<Record<string, unknown>> = [];
  let findPricing: ReturnType<typeof vi.fn>;

  const mockPrisma: Record<string, unknown> = {
    request: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'request-under-test' };
      }),
    },
    firstDispatchObservation: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  // `persistAndSettle` writes the row and the charge in ONE transaction; a
  // prisma mock without `$transaction` would model a client that cannot exist.
  mockPrisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma));

  const mockBilling = {
    // The dark-ship path: no enforcement and no caller idempotency key, so
    // there is no hold to settle against and the ledger is written directly.
    settleInTx: vi.fn(async (_tx: unknown, params: Record<string, unknown>) => {
      settled.push(params);
      return true;
    }),
    // The enforced path: a reservation exists and the charge releases it.
    settleIntentInTx: vi.fn(async (_tx: unknown, params: Record<string, unknown>) => {
      settled.push(params);
      return true;
    }),
    openIntent: vi.fn(async () => ({
      outcome: 'opened',
      intent: {
        id: 'intent-under-test',
        apiKeyId: 'key-1',
        intentKey: 'client-key-1',
        holdUsd: 0,
      },
    })),
    releaseIntent: vi.fn(async () => true),
  };

  const mockMetrics = { record: vi.fn(), getAll: vi.fn().mockReturnValue({}) };
  const emptyModalityCatalog = {
    getEntries: () => [],
    getFilteredEntries: () => [],
  } as unknown as ModalityCatalogService;

  function buildService(connector: IConnector): ConnectorsService {
    const catalogRepo: CatalogRepositoryLike = {
      findAll: vi.fn().mockResolvedValue([]),
      findPricing,
    };
    const service = new ConnectorsService(
      { add: vi.fn() } as unknown as Queue,
      mockPrisma as unknown as PrismaService,
      mockMetrics as unknown as MetricsService,
      new OutputGuardMiddleware({ enabled: false, maxRetries: 0, timeoutMs: 1_000 }),
      emptyModalityCatalog,
      catalogRepo,
      null,
      undefined,
      undefined,
      // Appended LAST, as the constructor's own comment insists.
      mockBilling as unknown as BillingService,
    );
    service.register(connector);
    return service;
  }

  beforeEach(() => {
    process.env.PROVIDER_ACCESS = '';
    created.length = 0;
    settled.length = 0;
    vi.clearAllMocks();
    findPricing = vi.fn().mockResolvedValue(null);
  });

  it('charges real money for a priced model the connector reported as costing nothing', async () => {
    // This is the falsifier in miniature: the connector returns costUsd 0 —
    // exactly what groq.connector.ts has always returned — and the amount that
    // reaches the ledger is nonetheless greater than zero.
    findPricing = vi.fn().mockResolvedValue(GROQ_PAID_ROW);
    const service = buildService(groqShapedConnector({ inputTokens: 1_000, outputTokens: 500 }));

    const response = await service.execute('groq', { prompt: 'hello' }, 'key-1');

    expect(response.usage.costUsd).toBeGreaterThan(0);
    expect(response.usage.costUsd).toBeCloseTo(0.000985, 9);

    expect(created).toHaveLength(1);
    expect(Number(created[0].costUsd)).toBeCloseTo(0.000985, 9);
    expect(created[0].costSource).toBe('catalog');

    expect(settled).toHaveLength(1);
    expect(Number(settled[0].amountUsd)).toBeCloseTo(0.000985, 9);
    expect(settled[0].idempotencyKey).toBe('request:request-under-test');
    expect(settled[0].reason).toBe('model-request');
  });

  it('prices the model the provider actually served, not the one that was asked for', async () => {
    findPricing = vi.fn().mockResolvedValue(GROQ_PAID_ROW);
    const service = buildService(groqShapedConnector({ inputTokens: 10, outputTokens: 10 }));

    await service.execute('groq', { prompt: 'hi', model: 'an-alias' }, 'key-1');

    expect(findPricing).toHaveBeenCalledWith('groq', 'llama-3.3-70b-versatile');
  });

  it('records an unpriced model as unpriced instead of as a zero charge', async () => {
    findPricing = vi.fn().mockResolvedValue(null);
    const service = buildService(groqShapedConnector({ inputTokens: 1_000, outputTokens: 500 }));

    await service.execute('groq', { prompt: 'hello' }, 'key-1');

    expect(created[0].costSource).toBe('unpriced');
    expect(Number(created[0].costUsd)).toBe(0);
    // The ledger row still exists (it reserves the idempotency key) but says
    // why it is zero, so a $0 charge that means "we could not price this" is
    // never mistaken for one that means "this model is free".
    expect(settled[0].reason).toBe('model-request:unpriced');
    expect(Number(settled[0].amountUsd)).toBe(0);
  });

  it('records a catalogued free-tier model as free, not as unpriced', async () => {
    findPricing = vi.fn().mockResolvedValue(GROQ_FREE_ROW);
    const service = buildService(groqShapedConnector({ inputTokens: 1_000, outputTokens: 500 }));

    await service.execute('groq', { prompt: 'hello' }, 'key-1');

    expect(created[0].costSource).toBe('catalog-free');
    expect(Number(created[0].costUsd)).toBe(0);
    expect(settled[0].reason).toBe('model-request');
  });

  it('does not overwrite a cost the provider reported itself', async () => {
    findPricing = vi.fn().mockResolvedValue(GROQ_PAID_ROW);
    const service = buildService(
      groqShapedConnector({ inputTokens: 1_000, outputTokens: 500, costUsd: 0.25 }),
    );

    await service.execute('groq', { prompt: 'hello' }, 'key-1');

    expect(Number(created[0].costUsd)).toBe(0.25);
    expect(created[0].costSource).toBe('provider');
    expect(Number(settled[0].amountUsd)).toBe(0.25);
  });

  it('treats a catalogue outage as unpriced rather than as free', async () => {
    // "The database was down" and "this model is free" must not produce the
    // same ledger row.
    findPricing = vi.fn().mockRejectedValue(new Error('catalog unavailable'));
    const service = buildService(groqShapedConnector({ inputTokens: 1_000, outputTokens: 500 }));

    await service.execute('groq', { prompt: 'hello' }, 'key-1');

    expect(created[0].costSource).toBe('unpriced');
    expect(settled[0].reason).toBe('model-request:unpriced');
  });

  it('falls back to the findAll scan when the repo has no findPricing', async () => {
    // Dozens of specs inject `{ findAll: vi.fn() }`; the meter must still work
    // against that shape rather than silently pricing everything at nothing.
    const service = new ConnectorsService(
      { add: vi.fn() } as unknown as Queue,
      mockPrisma as unknown as PrismaService,
      mockMetrics as unknown as MetricsService,
      new OutputGuardMiddleware({ enabled: false, maxRetries: 0, timeoutMs: 1_000 }),
      emptyModalityCatalog,
      {
        findAll: vi.fn().mockResolvedValue([
          { connector: 'other', model: 'x', ...GROQ_PAID_ROW },
          { connector: 'groq', model: 'llama-3.3-70b-versatile', ...GROQ_PAID_ROW },
        ]),
      } as unknown as CatalogRepositoryLike,
      null,
      undefined,
      undefined,
      mockBilling as unknown as BillingService,
    );
    service.register(groqShapedConnector({ inputTokens: 1_000, outputTokens: 500 }));

    await service.execute('groq', { prompt: 'hello' }, 'key-1');

    expect(created[0].costSource).toBe('catalog');
    expect(Number(created[0].costUsd)).toBeGreaterThan(0);
  });
  // ---------------------------------------------------------------------
  // ARAS-0058 (#95 x #96) — the meter through a HELD intent.
  //
  // Everything above exercises the dark-ship path, where no reservation
  // exists. Enforcement settles through `settleIntentInTx` instead, which
  // releases the hold and charges in the same transaction — a genuinely
  // different call site, and the one real money will take. The provenance has
  // to survive that path too, or the marker exists only where it is not
  // needed.
  //
  // A caller-supplied idempotency key opens an intent without requiring
  // enforcement to be configured, which is what makes this reachable in a unit
  // test at all.
  // ---------------------------------------------------------------------

  it('settles a held intent with the metered amount, not the connector zero', async () => {
    findPricing = vi.fn().mockResolvedValue(GROQ_PAID_ROW);
    const service = buildService(groqShapedConnector({ inputTokens: 1_000, outputTokens: 500 }));

    await service.execute('groq', { prompt: 'hello', idempotencyKey: 'client-key-1' }, 'key-1');

    expect(mockBilling.settleIntentInTx).toHaveBeenCalledTimes(1);
    expect(mockBilling.settleInTx).not.toHaveBeenCalled();
    expect(created[0].costSource).toBe('catalog');
    expect(Number(settled[0].amountUsd)).toBeCloseTo(0.000985, 9);
    expect(settled[0].reason).toBe('model-request');
  });

  it('carries the unpriced marker into the ledger when a hold is being released', async () => {
    // The dangerous case. The hold is given back in full and the charge is
    // $0.000000, so the account is made whole while the tokens were served for
    // nothing — and `chargeInTx` writes no `uncollectible` entry, because
    // there is no amount to write off. If the reason came through as a plain
    // `model-request`, that settle would be indistinguishable in the ledger
    // from a genuinely free model, which is precisely the bug this epic
    // exists to remove.
    findPricing = vi.fn().mockResolvedValue(null);
    const service = buildService(groqShapedConnector({ inputTokens: 1_000, outputTokens: 500 }));

    await service.execute('groq', { prompt: 'hello', idempotencyKey: 'client-key-1' }, 'key-1');

    expect(mockBilling.settleIntentInTx).toHaveBeenCalledTimes(1);
    expect(created[0].costSource).toBe('unpriced');
    expect(Number(created[0].costUsd)).toBe(0);
    expect(settled[0].reason).toBe('model-request:unpriced');
    expect(Number(settled[0].amountUsd)).toBe(0);
    // The hold is settled, never abandoned: releasing instead would leave the
    // intent key unburned and the request replayable against a fresh charge.
    expect(mockBilling.releaseIntent).not.toHaveBeenCalled();
  });

  it('writes the request row and the charge in a single transaction', async () => {
    // The durability fix from #96 must still hold with the meter in front of
    // it: a measured cost that commits without its charge is the divergence
    // the transaction exists to prevent.
    findPricing = vi.fn().mockResolvedValue(GROQ_PAID_ROW);
    const service = buildService(groqShapedConnector({ inputTokens: 1_000, outputTokens: 500 }));

    await service.execute('groq', { prompt: 'hello' }, 'key-1');

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
