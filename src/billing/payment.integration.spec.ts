/**
 * BILL-0008 — the payment path and the reversal primitive, against a REAL
 * Postgres.
 *
 * Integration rather than unit throughout, and not by preference. Almost every
 * guarantee here is enforced by the DATABASE — a unique index, four CHECK
 * constraints, a NOT NULL with no default, and a foreign key's ON DELETE rule.
 * A mocked Prisma reports whatever it is told and would pass with every one of
 * them dropped, which is the precise failure this file exists to make
 * impossible. The consilium's blocking list (§4) is a list of things that must
 * be true of the schema before the first irreversible payment; only a real
 * schema can answer.
 */

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BillingService } from './billing.service';
import { ReversalRefusedError } from './billing.errors';
import { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaService();
const billing = new BillingService(prisma);

// Integration specs in src/billing share one database and run in parallel, so
// every file owns its own key or they trample each other's reset.
const KEY_ID = '77777777-7777-4777-8777-777777777777';

async function reset(): Promise<void> {
  await prisma.requestIntent.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsLedger.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsBalance.deleteMany({ where: { apiKeyId: KEY_ID } });
}

/** The materialised balance, and the ledger it is supposed to equal. */
async function balances(): Promise<{ balance: Prisma.Decimal; ledgerSum: Prisma.Decimal }> {
  const row = await prisma.creditsBalance.findUnique({ where: { apiKeyId: KEY_ID } });
  const entries = await prisma.creditsLedger.findMany({
    where: { apiKeyId: KEY_ID },
    select: { amountUsd: true },
  });
  return {
    balance: row?.balanceUsd ?? new Prisma.Decimal(0),
    ledgerSum: entries.reduce((acc, e) => acc.plus(e.amountUsd), new Prisma.Decimal(0)),
  };
}

/**
 * The two invariants that must hold after EVERY movement, asserted together
 * because holding either one alone is easy and holding both is the whole
 * difficulty: clamping the balance keeps it non-negative and breaks the sum,
 * and posting freely keeps the sum and breaks the floor.
 */
async function expectInvariants(): Promise<Prisma.Decimal> {
  const { balance, ledgerSum } = await balances();
  expect(balance.toString()).toBe(ledgerSum.toString());
  expect(balance.greaterThanOrEqualTo(0)).toBe(true);
  return balance;
}

function payment(over: Record<string, unknown> = {}) {
  return {
    apiKeyId: KEY_ID,
    amountUsd: '180.000000',
    idempotencyKey: 'oxapay:payment:trk_0001',
    source: 'oxapay',
    livemode: false,
    externalRef: 'trk_0001',
    actor: 'control-bff',
    ...over,
  } as Parameters<BillingService['recordPayment']>[0];
}

beforeAll(async () => {
  await prisma.apiKey.upsert({
    where: { id: KEY_ID },
    create: { id: KEY_ID, name: 'bill-0008-test', keyHash: `hash-${KEY_ID}` },
    update: {},
  });
});
beforeEach(reset);
afterAll(async () => {
  // Order matters now: `credits_ledger.api_key_id` is ON DELETE RESTRICT, so
  // the key cannot be dropped while it has history. That is the behaviour under
  // test below, not an inconvenience.
  await reset();
  await prisma.apiKey.deleteMany({ where: { id: KEY_ID } });
  await prisma.$disconnect();
});

describe('BillingService.recordPayment', () => {
  it('credits the balance and records the entry as a payment', async () => {
    expect(await billing.recordPayment(payment())).toBe(true);

    const row = await prisma.creditsLedger.findUnique({
      where: { idempotencyKey: 'oxapay:payment:trk_0001' },
    });
    expect(row?.entryType).toBe('payment');
    // Distinguishable from a gift, which is the accounting requirement:
    // revenue must never include money nobody paid.
    expect(row?.entryType).not.toBe('gift');
    expect(row?.amountUsd.toNumber()).toBe(180);
    expect((await expectInvariants()).toNumber()).toBe(180);
  });

  it('records provenance that cannot be reconstructed later', async () => {
    await billing.recordPayment(
      payment({
        valuation: {
          assetAmount: '0.003100000000000000',
          asset: 'BTC',
          usdRateAtReceipt: '58064.516129032258064500',
          valuedAt: new Date('2026-08-29T10:00:00.000Z'),
        },
      }),
    );

    const row = await prisma.creditsLedger.findUnique({
      where: { idempotencyKey: 'oxapay:payment:trk_0001' },
    });
    expect(row?.source).toBe('oxapay');
    expect(row?.externalRef).toBe('trk_0001');
    expect(row?.livemode).toBe(false);
    expect(row?.actor).toBe('control-bff');
    expect(row?.asset).toBe('BTC');
    expect(row?.assetAmount?.toString()).toBe('0.0031');
    // The rate at receipt is gone the instant it passes; this is the only copy.
    expect(row?.usdRateAtReceipt?.toNumber()).toBeCloseTo(58064.516129, 5);
    expect(row?.valuedAt?.toISOString()).toBe('2026-08-29T10:00:00.000Z');
  });

  it('keeps the crypto valuation INERT — the USD amount is the ledger number', async () => {
    // Consilium §2 forbids a rate from deciding a credit; §4.2 requires the
    // rate to be recorded. Both hold only if the stored valuation has no
    // arithmetic relationship to `amount_usd`. Here it deliberately does not
    // multiply out, and the credit is still exactly the USD passed in.
    await billing.recordPayment(
      payment({
        amountUsd: '180.000000',
        valuation: { assetAmount: '999', asset: 'BTC', usdRateAtReceipt: '999999' },
      }),
    );
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(180);
  });

  /** V-AC: same idempotency key twice → ONE row, the second a no-op. */
  it('credits exactly once for a replayed idempotency key', async () => {
    const first = await billing.recordPayment(payment());
    const second = await billing.recordPayment(payment());

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(
      await prisma.creditsLedger.count({ where: { idempotencyKey: 'oxapay:payment:trk_0001' } }),
    ).toBe(1);
    expect((await expectInvariants()).toNumber()).toBe(180);
  });

  it('credits exactly once when replays arrive concurrently', async () => {
    // The sequential case above passes against a read-then-write check. Firing
    // together is what proves the DATABASE enforces it — and a gateway
    // retrying a callback in parallel is the normal shape, not an edge case.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => billing.recordPayment(payment()).catch(() => false)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await expectInvariants()).toNumber()).toBe(180);
  });

  it.each(['Infinity', '-Infinity', 'NaN'])('refuses a non-finite amount (%s)', async (amount) => {
    await expect(billing.recordPayment(payment({ amountUsd: amount }))).rejects.toThrow(/finite/);
    expect((await balances()).ledgerSum.toNumber()).toBe(0);
  });

  it('refuses an amount above the per-credit ceiling', async () => {
    // Above this the ledger's own DECIMAL(12,6) balance column cannot hold the
    // result, so an unbounded credit fails as a Postgres numeric overflow at
    // the moment money has already been received.
    await expect(billing.recordPayment(payment({ amountUsd: '100000.01' }))).rejects.toThrow(
      /ceiling/,
    );
  });

  it.each(['0', '-5'])('refuses a non-positive amount (%s)', async (amount) => {
    await expect(billing.recordPayment(payment({ amountUsd: amount }))).rejects.toThrow(
      /greater than zero/,
    );
  });

  it('refuses a payment with no source', async () => {
    await expect(billing.recordPayment(payment({ source: '  ' }))).rejects.toThrow(/source/);
  });
});

describe('BillingService.reverse', () => {
  const REVERSAL = { idempotencyKey: 'oxapay:refund:trk_0001', reason: 'customer requested' };

  /** V-AC: balance ends at start + payment − reversal, invariants intact. */
  it('posts a negative entry and lands the balance at start + payment - reversal', async () => {
    await billing.gift({
      apiKeyId: KEY_ID,
      amountUsd: '20',
      idempotencyKey: 'starting-float',
      reason: 'starting balance',
    });
    await billing.recordPayment(payment());
    expect((await expectInvariants()).toNumber()).toBe(200);

    const result = await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '50',
      ...REVERSAL,
    });

    expect(result.applied).toBe(true);
    expect(result.recoveredUsd).toBe('50');
    expect(result.writtenOffUsd).toBe('0');
    // 20 + 180 - 50
    expect((await expectInvariants()).toNumber()).toBe(150);

    const row = await prisma.creditsLedger.findUnique({
      where: { idempotencyKey: REVERSAL.idempotencyKey },
    });
    expect(row?.entryType).toBe('refund');
    expect(row?.amountUsd.toNumber()).toBe(-50);
    // The reversal names the entry it reverses, so it is explainable from the
    // ledger alone rather than from someone's memory.
    expect(row?.reversalOf).toBe('oxapay:payment:trk_0001');
    // Provenance is copied from the original, so a report can join the two
    // without a second lookup.
    expect(row?.source).toBe('oxapay');
    expect(row?.externalRef).toBe('trk_0001');
  });

  it('reverses the full amount back to zero', async () => {
    await billing.recordPayment(payment());
    await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '180',
      ...REVERSAL,
    });
    expect((await expectInvariants()).toNumber()).toBe(0);
  });

  it('records a chargeback distinctly from a refund', async () => {
    // Same arithmetic, different facts: one is money we chose to return, the
    // other is money taken from us. A history that cannot tell them apart
    // cannot separate a customer-service number from a fraud number.
    await billing.recordPayment(payment());
    await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '180',
      idempotencyKey: 'oxapay:chargeback:trk_0001',
      reason: 'provider reversed the settlement',
      entryType: 'chargeback',
    });
    const row = await prisma.creditsLedger.findUnique({
      where: { idempotencyKey: 'oxapay:chargeback:trk_0001' },
    });
    expect(row?.entryType).toBe('chargeback');
  });

  /**
   * The case the balance floor exists for. The customer spent the money before
   * the reversal arrived; the reversal is still recorded IN FULL, and the part
   * that could not be recovered is written off, so both invariants survive.
   */
  it('writes off the part of a reversal the balance cannot give back', async () => {
    await billing.recordPayment(payment({ amountUsd: '100' }));
    await billing.settle({ apiKeyId: KEY_ID, amountUsd: '90', idempotencyKey: 'spend-it' });
    expect((await expectInvariants()).toNumber()).toBe(10);

    const result = await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '100',
      ...REVERSAL,
    });

    expect(result.reversedUsd).toBe('100');
    expect(result.recoveredUsd).toBe('10');
    expect(result.writtenOffUsd).toBe('90');

    // The negative entry is the FULL 100 — the ledger records what happened,
    // not what we could collect.
    const reversal = await prisma.creditsLedger.findUnique({
      where: { idempotencyKey: REVERSAL.idempotencyKey },
    });
    expect(reversal?.amountUsd.toNumber()).toBe(-100);

    // ...and the 90 we could not recover is a queryable row, not an inference
    // from a balance that silently failed to move.
    const writeOff = await prisma.creditsLedger.findUnique({
      where: { idempotencyKey: `${REVERSAL.idempotencyKey}:unrecovered` },
    });
    expect(writeOff?.entryType).toBe('uncollectible');
    expect(writeOff?.amountUsd.toNumber()).toBe(90);
    expect(writeOff?.reversalOf).toBe('oxapay:payment:trk_0001');

    // Both invariants, which is the point: the CHECK is never violated AND the
    // balance still equals the sum of the ledger.
    expect((await expectInvariants()).toNumber()).toBe(0);
  });

  it('never claws back funds already held for an in-flight request', async () => {
    // A hold is money reserved for a request already dispatched to a provider
    // that will bill us. Recovering it here would overdraw a request that had
    // already been told it could proceed.
    await billing.recordPayment(payment({ amountUsd: '100' }));
    const opened = await billing.openIntent({
      apiKeyId: KEY_ID,
      intentKey: 'in-flight-request',
      clientSupplied: true,
      payloadFingerprint: 'fp',
      holdUsd: new Prisma.Decimal('60'),
    });
    expect(opened.outcome).toBe('opened');

    const result = await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '100',
      ...REVERSAL,
    });

    // Spendable was 100 - 60 = 40, so only 40 comes back.
    expect(result.recoveredUsd).toBe('40');
    expect(result.writtenOffUsd).toBe('60');
    const { balance } = await balances();
    expect(balance.toNumber()).toBe(60);
    // The hold is still fully covered — held never exceeds the balance.
    const row = await prisma.creditsBalance.findUnique({ where: { apiKeyId: KEY_ID } });
    expect(row!.heldUsd.toNumber()).toBe(60);
    expect(balance.greaterThanOrEqualTo(row!.heldUsd)).toBe(true);
    await expectInvariants();
  });

  it('reverses only once for a replayed reversal key', async () => {
    await billing.recordPayment(payment());
    const first = await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '50',
      ...REVERSAL,
    });
    const second = await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '50',
      ...REVERSAL,
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(
      await prisma.creditsLedger.count({ where: { reversalOf: 'oxapay:payment:trk_0001' } }),
    ).toBe(1);
    expect((await expectInvariants()).toNumber()).toBe(130);
  });

  it('allows partial reversals up to the original and refuses the one that would exceed it', async () => {
    await billing.recordPayment(payment({ amountUsd: '100' }));
    await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '60',
      idempotencyKey: 'refund-part-1',
      reason: 'partial one',
    });
    await billing.reverse({
      originalIdempotencyKey: 'oxapay:payment:trk_0001',
      amountUsd: '40',
      idempotencyKey: 'refund-part-2',
      reason: 'partial two',
    });
    expect((await expectInvariants()).toNumber()).toBe(0);

    // Without the running total, a sequence of partial refunds quietly becomes
    // a withdrawal.
    await expect(
      billing.reverse({
        originalIdempotencyKey: 'oxapay:payment:trk_0001',
        amountUsd: '1',
        idempotencyKey: 'refund-part-3',
        reason: 'one too many',
      }),
    ).rejects.toMatchObject({ reason: 'exceeds_original' });
  });

  it('refuses a reversal against an idempotency key that was never posted', async () => {
    await expect(
      billing.reverse({
        originalIdempotencyKey: 'oxapay:payment:never-happened',
        amountUsd: '10',
        ...REVERSAL,
      }),
    ).rejects.toMatchObject({ reason: 'original_not_found' });
    expect((await balances()).ledgerSum.toNumber()).toBe(0);
  });

  it('refuses to reverse a charge', async () => {
    // Undoing a charge is a credit, and it must look like one in the history —
    // otherwise the sum over refunds stops meaning "money returned".
    await billing.gift({
      apiKeyId: KEY_ID,
      amountUsd: '20',
      idempotencyKey: 'float-for-charge',
      reason: 'starting balance',
    });
    await billing.settle({ apiKeyId: KEY_ID, amountUsd: '5', idempotencyKey: 'a-charge' });

    await expect(
      billing.reverse({ originalIdempotencyKey: 'a-charge', amountUsd: '5', ...REVERSAL }),
    ).rejects.toBeInstanceOf(ReversalRefusedError);
    expect((await expectInvariants()).toNumber()).toBe(15);
  });

  it.each(['0', '-5', 'Infinity'])('refuses an invalid magnitude (%s)', async (amount) => {
    await billing.recordPayment(payment());
    await expect(
      billing.reverse({
        originalIdempotencyKey: 'oxapay:payment:trk_0001',
        amountUsd: amount,
        ...REVERSAL,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
    expect((await expectInvariants()).toNumber()).toBe(180);
  });

  it('refuses a reversal with no reason', async () => {
    await billing.recordPayment(payment());
    await expect(
      billing.reverse({
        originalIdempotencyKey: 'oxapay:payment:trk_0001',
        amountUsd: '10',
        idempotencyKey: 'refund-no-reason',
        reason: '   ',
      }),
    ).rejects.toThrow(/reason/);
  });

  it('can reverse a gift as well as a payment', async () => {
    // An operator gift entered by mistake was equally un-postable before this.
    await billing.gift({
      apiKeyId: KEY_ID,
      amountUsd: '30',
      idempotencyKey: 'gift-by-mistake',
      reason: 'wrong account',
    });
    const result = await billing.reverse({
      originalIdempotencyKey: 'gift-by-mistake',
      amountUsd: '30',
      idempotencyKey: 'undo-the-gift',
      reason: 'gifted the wrong account',
    });
    expect(result.applied).toBe(true);
    expect((await expectInvariants()).toNumber()).toBe(0);
  });
});

/**
 * The constraints themselves. Every assertion here is a raw INSERT, because the
 * whole question is what the DATABASE refuses when application code is
 * bypassed, forgotten, or written by someone who never read this service.
 */
describe('credits_ledger constraints', () => {
  const base = (cols: string, vals: string) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO credits_ledger (id, api_key_id, amount_usd, reason, idempotency_key${cols})
       VALUES (gen_random_uuid(), '${KEY_ID}', ${vals})`,
    );

  /** V-AC: a row without `entryType` is rejected — no silent 'charge' default. */
  it('rejects a row that sets no entry_type', async () => {
    // It was `@default("charge")`, so a caller that forgot the field posted a
    // row labelled a debit. For a payment that is money a customer sent,
    // recorded as spend, with the arithmetic still correct and no reader able
    // to notice. Dropping the DEFAULT is the load-bearing half: NOT NULL alone
    // would still let the default supply 'charge'.
    await expect(base('', `10, 'no type', 'raw-no-entry-type'`)).rejects.toThrow(
      /null value in column "entry_type"|not-null constraint/i,
    );
  });

  it('rejects an entry_type outside the permitted set', async () => {
    await expect(base(', entry_type', `10, 'invented', 'raw-bad-type', 'bonus'`)).rejects.toThrow(
      /credits_ledger_entry_type_known/,
    );
  });

  it('rejects a payment with no source or no livemode', async () => {
    // Un-backfillable: NULL here can only ever mean "not a payment", never "a
    // payment whose details we lost".
    await expect(
      base(', entry_type, livemode', `10, 'no source', 'raw-no-source', 'payment', true`),
    ).rejects.toThrow(/credits_ledger_payment_has_provenance/);
    await expect(
      base(', entry_type, source', `10, 'no livemode', 'raw-no-livemode', 'payment', 'oxapay'`),
    ).rejects.toThrow(/credits_ledger_payment_has_provenance/);
  });

  it('rejects a reversal that names no original', async () => {
    await expect(
      base(', entry_type', `-10, 'unexplained', 'raw-orphan-reversal', 'refund'`),
    ).rejects.toThrow(/credits_ledger_reversal_names_original/);
  });

  it('rejects a payment with a non-positive amount', async () => {
    await expect(
      base(
        ', entry_type, source, livemode',
        `-10, 'negative payment', 'raw-neg-payment', 'payment', 'oxapay', false`,
      ),
    ).rejects.toThrow(/credits_ledger_payment_positive/);
  });

  it('rejects a reversal with a non-negative amount', async () => {
    await expect(
      base(
        ', entry_type, reversal_of',
        `10, 'positive refund', 'raw-pos-refund', 'refund', 'whatever'`,
      ),
    ).rejects.toThrow(/credits_ledger_reversal_negative/);
  });

  /**
   * Consilium §6.4. The FK was ON DELETE CASCADE: revoking a key deleted its
   * ledger history. Once a row records money a stranger actually sent, that
   * destroys the financial record of a receipt — and an irreversible crypto
   * receipt has no second copy anywhere to rebuild from.
   */
  it('refuses to delete an ApiKey that has ledger history', async () => {
    await billing.recordPayment(payment());

    await expect(prisma.apiKey.delete({ where: { id: KEY_ID } })).rejects.toThrow(
      /Foreign key constraint|violates foreign key/i,
    );

    // The receipt survived the attempt.
    expect(await prisma.creditsLedger.count({ where: { apiKeyId: KEY_ID } })).toBe(1);
    // And the key is still there, which is the intended answer: a key with
    // money in its history is deactivated (`ApiKey.active = false`), not
    // deleted.
    expect(await prisma.apiKey.findUnique({ where: { id: KEY_ID } })).not.toBeNull();
  });
});
