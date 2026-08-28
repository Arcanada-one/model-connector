/**
 * ARAS-0064 — billing against a REAL Postgres.
 *
 * Integration rather than unit on purpose. The load-bearing guarantee here is
 * that a repeated settle cannot double-charge, and that guarantee is a UNIQUE
 * CONSTRAINT in the database. A mocked Prisma would happily report whatever the
 * mock was told to report, so a unit test would assert the mock, not the
 * invariant — it could not fail even if the constraint were dropped.
 *
 * Requires DATABASE_URL pointing at a schema-synced database (see
 * `pnpm test:integration`).
 */

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InsufficientCreditsError } from './billing.errors';
import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

// The production class, not a bare PrismaClient: it owns the driver adapter,
// so testing through it exercises the same construction the service gets at
// runtime rather than a parallel one that could drift.
const prisma = new PrismaService();
const billing = new BillingService(prisma);

const KEY_ID = '11111111-1111-4111-8111-111111111111';

async function resetAccount(): Promise<void> {
  await prisma.creditsLedger.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsBalance.deleteMany({ where: { apiKeyId: KEY_ID } });
}

beforeAll(async () => {
  await prisma.apiKey.upsert({
    where: { id: KEY_ID },
    create: { id: KEY_ID, name: 'aras-0064-test', keyHash: `hash-${KEY_ID}` },
    update: {},
  });
});

beforeEach(resetAccount);

afterAll(async () => {
  await resetAccount();
  await prisma.apiKey.deleteMany({ where: { id: KEY_ID } });
  await prisma.$disconnect();
});

describe('BillingService', () => {
  it('reads zero for an account that has never been credited', async () => {
    expect((await billing.balance(KEY_ID)).toString()).toBe('0');
  });

  it('credits the operator top-up and reflects it in the balance', async () => {
    await billing.credit({ apiKeyId: KEY_ID, amountUsd: '10', idempotencyKey: 'topup-1' });
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(10);
  });

  it('charges two different models different amounts', async () => {
    await billing.credit({ apiKeyId: KEY_ID, amountUsd: '10', idempotencyKey: 'topup-2' });

    // Distinct per-model costs, as the connector measures them.
    await billing.settle({ apiKeyId: KEY_ID, amountUsd: '0.002500', idempotencyKey: 'req-cheap' });
    await billing.settle({ apiKeyId: KEY_ID, amountUsd: '0.750000', idempotencyKey: 'req-costly' });

    expect((await billing.balance(KEY_ID)).toNumber()).toBeCloseTo(10 - 0.0025 - 0.75, 6);

    const debits = await prisma.creditsLedger.findMany({
      where: { apiKeyId: KEY_ID, amountUsd: { lt: new Prisma.Decimal(0) } },
      orderBy: { amountUsd: 'asc' },
    });
    // The two charges must differ — a flat fee would satisfy a balance check
    // but not per-model billing.
    expect(debits).toHaveLength(2);
    expect(debits[0].amountUsd.toString()).not.toBe(debits[1].amountUsd.toString());
  });

  it('does not charge twice for the same idempotency key', async () => {
    await billing.credit({ apiKeyId: KEY_ID, amountUsd: '5', idempotencyKey: 'topup-3' });

    const first = await billing.settle({
      apiKeyId: KEY_ID,
      amountUsd: '1.000000',
      idempotencyKey: 'retried-request',
    });
    const second = await billing.settle({
      apiKeyId: KEY_ID,
      amountUsd: '1.000000',
      idempotencyKey: 'retried-request',
    });

    expect(first).toBe(true);
    expect(second).toBe(false); // reported as already-settled, not charged
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(4);
    expect(await prisma.creditsLedger.count({ where: { idempotencyKey: 'retried-request' } })).toBe(
      1,
    );
  });

  it('does not double-charge when concurrent retries race', async () => {
    await billing.credit({ apiKeyId: KEY_ID, amountUsd: '5', idempotencyKey: 'topup-4' });

    // The sequential test above would pass against a read-then-write check.
    // Firing them together is what proves the DATABASE enforces it: a
    // check-then-insert races precisely here.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        billing
          .settle({ apiKeyId: KEY_ID, amountUsd: '1.000000', idempotencyKey: 'raced-request' })
          .catch(() => false),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(4);
  });

  it('blocks a call when the balance cannot cover the estimate', async () => {
    await expect(billing.precheck(KEY_ID, '0.01')).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('allows a call the balance can cover', async () => {
    await billing.credit({ apiKeyId: KEY_ID, amountUsd: '1', idempotencyKey: 'topup-5' });
    await expect(billing.precheck(KEY_ID, '0.5')).resolves.toBeUndefined();
  });

  it('refuses a settle with a negative amount', async () => {
    // settle() charges. A negative amount would silently CREDIT the account —
    // a sign-flip bug that pays customers instead of billing them.
    await expect(
      billing.settle({ apiKeyId: KEY_ID, amountUsd: '-5', idempotencyKey: 'sign-flip' }),
    ).rejects.toThrow(/negative amount would credit/);
  });
});
