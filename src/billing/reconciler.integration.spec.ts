/**
 * ARAS-0058 — the reconciler, against a real Postgres.
 *
 * `settleSpend`'s docstring defended being non-fatal on the grounds that "the
 * ledger's absence is recoverable from the Request row, which is written
 * first". No such recovery job existed. Naming a compensating control and not
 * building it does not mitigate the risk; it documents it — and meanwhile every
 * dropped settle left nothing behind but an ERROR line nobody alerts on.
 *
 * These tests are the job, and the bounds on it. The bounds matter as much as
 * the behaviour: a recovery job that CHARGES is one wrong window away from
 * invoicing every account for its entire history.
 */

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing.service';
import { BillingReconcilerService } from './reconciler.service';
import { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaService();
const billing = new BillingService(prisma);
const reconciler = new BillingReconcilerService(prisma, billing);

const KEY_ID = '55555555-5555-4555-8555-555555555555';

const MINUTE = 60 * 1000;

/** A completed request that measured spend. `settled` decides whether the ledger knows. */
async function plantRequest(opts: {
  costUsd: string;
  ageMs: number;
  settled?: boolean;
}): Promise<string> {
  const created = await prisma.request.create({
    data: {
      connector: 'groq',
      model: 'llama',
      promptHash: 'hash',
      promptLength: 10,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costUsd: new Prisma.Decimal(opts.costUsd),
      latencyMs: 5,
      status: 'success',
      apiKeyId: KEY_ID,
      createdAt: new Date(Date.now() - opts.ageMs),
    },
  });
  if (opts.settled) {
    await billing.settle({
      apiKeyId: KEY_ID,
      amountUsd: opts.costUsd,
      idempotencyKey: `request:${created.id}`,
      requestId: created.id,
      reason: 'model-request',
    });
  }
  return created.id;
}

async function resetAccount(): Promise<void> {
  await prisma.request.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.requestIntent.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsLedger.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsBalance.deleteMany({ where: { apiKeyId: KEY_ID } });
}

async function fund(amountUsd: string): Promise<void> {
  await billing.credit({
    apiKeyId: KEY_ID,
    amountUsd,
    idempotencyKey: `fund-${KEY_ID}-${Math.random()}`,
    reason: 'test funding',
  });
}

beforeAll(async () => {
  await prisma.apiKey.upsert({
    where: { id: KEY_ID },
    create: { id: KEY_ID, name: 'aras-0058-reconciler-test', keyHash: `hash-${KEY_ID}` },
    update: {},
  });
});

beforeEach(resetAccount);

afterAll(async () => {
  await resetAccount();
  await prisma.apiKey.deleteMany({ where: { id: KEY_ID } });
  await prisma.$disconnect();
});

describe('the reconciler', () => {
  it('settles measured spend that never reached the ledger', async () => {
    await fund('10');
    const orphan = await plantRequest({ costUsd: '0.25', ageMs: 30 * MINUTE });

    const report = await reconciler.reconcile();

    expect(report.settled).toBe(1);
    expect(report.failed).toBe(0);
    expect((await billing.balance(KEY_ID)).toString()).toBe('9.75');

    const charge = await prisma.creditsLedger.findFirst({
      where: { apiKeyId: KEY_ID, entryType: 'charge' },
    });
    expect(charge?.requestId).toBe(orphan);
    expect(charge?.reason).toBe('reconciled-request');
  });

  it('leaves an already-settled request alone', async () => {
    await fund('10');
    await plantRequest({ costUsd: '0.25', ageMs: 30 * MINUTE, settled: true });

    const report = await reconciler.reconcile();

    expect(report.scanned).toBe(0);
    expect(report.settled).toBe(0);
    expect((await billing.balance(KEY_ID)).toString()).toBe('9.75');
  });

  it('cannot double-charge a request even when run twice', async () => {
    // Two reconcilers racing is an expected condition, not a fault: the key is
    // `request:<id>`, so the database refuses the second charge.
    await fund('10');
    await plantRequest({ costUsd: '0.25', ageMs: 30 * MINUTE });

    await reconciler.reconcile();
    const second = await reconciler.reconcile();

    expect(second.settled).toBe(0);
    expect((await billing.balance(KEY_ID)).toString()).toBe('9.75');
    const charges = await prisma.creditsLedger.findMany({
      where: { apiKeyId: KEY_ID, entryType: 'charge' },
    });
    expect(charges).toHaveLength(1);
  });

  it('reuses the pre-ARAS-0058 ledger key, so a half-settled row is not charged again', async () => {
    // The old settle path keyed on `request:<id>`. If the reconciler had chosen
    // a new key it would cheerfully charge a second time for every request that
    // path DID settle.
    await fund('10');
    const id = await plantRequest({ costUsd: '0.25', ageMs: 30 * MINUTE });
    await billing.settle({
      apiKeyId: KEY_ID,
      amountUsd: '0.25',
      idempotencyKey: `request:${id}`,
      requestId: id,
    });

    const report = await reconciler.reconcile();
    expect(report.scanned).toBe(0);
    expect((await billing.balance(KEY_ID)).toString()).toBe('9.75');
  });

  it('ignores a request still inside the grace window', async () => {
    // Settlement is transactional with the Request row now, but the reconciler
    // must not race anything that settles out of band. "The unique constraint
    // saved us" is not a design.
    await fund('10');
    await plantRequest({ costUsd: '0.25', ageMs: 30 * 1000 });

    const report = await reconciler.reconcile();
    expect(report.scanned).toBe(0);
    expect((await billing.balance(KEY_ID)).toString()).toBe('10');
  });

  it('ignores a request older than the window, so it can never backfill history', async () => {
    // Production carries Request rows that pre-date the credits tables
    // existing. An unbounded reconciler would charge every account for months
    // of historic usage on its first tick after a deploy.
    await fund('10');
    await plantRequest({ costUsd: '0.25', ageMs: 40 * 24 * 60 * MINUTE });

    const report = await reconciler.reconcile();
    expect(report.scanned).toBe(0);
    expect((await billing.balance(KEY_ID)).toString()).toBe('10');
  });

  it('ignores a zero-cost request', async () => {
    await fund('10');
    await plantRequest({ costUsd: '0', ageMs: 30 * MINUTE });

    expect((await reconciler.reconcile()).scanned).toBe(0);
  });

  it('reports without charging under dryRun', async () => {
    // The endpoint defaults to this. The operator asking "what did we miss?"
    // and the operator saying "now bill for it" are two different decisions.
    await fund('10');
    await plantRequest({ costUsd: '0.25', ageMs: 30 * MINUTE });

    const report = await reconciler.reconcile({ dryRun: true });

    expect(report.scanned).toBe(1);
    expect(report.totalUsd).toBe('0.25');
    expect(report.settled).toBe(0);
    expect((await billing.balance(KEY_ID)).toString()).toBe('10');
  });

  it('keeps going after one request fails to settle', async () => {
    // A recovery job's whole value is that it makes progress on a bad day. One
    // settle is made to throw; the other must still land, and the report must
    // say plainly that one did not.
    await fund('10');
    const doomed = await plantRequest({ costUsd: '0.25', ageMs: 30 * MINUTE });
    await plantRequest({ costUsd: '0.50', ageMs: 29 * MINUTE });

    const real = billing.settle.bind(billing);
    const spy = vi
      .spyOn(billing, 'settle')
      .mockImplementation(async (params: Parameters<typeof real>[0]) => {
        if (params.requestId === doomed) throw new Error('connection reset mid-settle');
        return real(params);
      });
    try {
      const report = await reconciler.reconcile({ limit: 10 });

      expect(report.scanned).toBe(2);
      expect(report.settled).toBe(1);
      expect(report.failed).toBe(1);
      // The one that worked worked. A single bad row does not abandon the pass.
      expect((await billing.balance(KEY_ID)).toString()).toBe('9.5');
    } finally {
      spy.mockRestore();
    }

    // And the failed one is still orphaned, so the next pass picks it up.
    const remaining = await reconciler.findUnsettled();
    expect(remaining.map((r) => r.id)).toEqual([doomed]);
    expect((await reconciler.reconcile()).settled).toBe(1);
    expect((await billing.balance(KEY_ID)).toString()).toBe('9.25');
  });

  it('settles more than it can collect as an explicit write-off', async () => {
    // A reconciled charge arrives long after the fact, against whatever balance
    // is left. It is still recorded in full; the database floor is respected by
    // writing off the shortfall, not by dropping the charge.
    await fund('0.10');
    await plantRequest({ costUsd: '0.25', ageMs: 30 * MINUTE });

    expect((await reconciler.reconcile()).settled).toBe(1);
    expect((await billing.balance(KEY_ID)).toString()).toBe('0');

    const writeOff = await prisma.creditsLedger.findFirst({
      where: { apiKeyId: KEY_ID, entryType: 'uncollectible' },
    });
    expect(new Prisma.Decimal(writeOff!.amountUsd).toString()).toBe('0.15');
  });
});
