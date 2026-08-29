/**
 * ARAS-0071 — gift crediting, against a REAL Postgres.
 *
 * Integration rather than unit for the same reason as the rest of billing: the
 * anti-double-gift guarantee is a UNIQUE CONSTRAINT, and a mocked Prisma would
 * report whatever it was told and pass even with the constraint dropped.
 */

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaService();
const billing = new BillingService(prisma);

const KEY_ID = '22222222-2222-4222-8222-222222222222';

async function reset(): Promise<void> {
  await prisma.creditsLedger.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsBalance.deleteMany({ where: { apiKeyId: KEY_ID } });
}

beforeAll(async () => {
  await prisma.apiKey.upsert({
    where: { id: KEY_ID },
    create: { id: KEY_ID, name: 'aras-0071-test', keyHash: `hash-${KEY_ID}` },
    update: {},
  });
});
beforeEach(reset);
afterAll(async () => {
  await reset();
  await prisma.apiKey.deleteMany({ where: { id: KEY_ID } });
  await prisma.$disconnect();
});

describe('BillingService.gift', () => {
  it('increases the balance by exactly the amount', async () => {
    await billing.gift({
      apiKeyId: KEY_ID,
      amountUsd: '25.500000',
      idempotencyKey: 'gift-exact',
      reason: 'operator starting balance',
    });
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(25.5);
  });

  it('records the entry as a gift, distinguishable from a charge', async () => {
    // A gift and a payment are the same arithmetic and different facts.
    // Revenue must never include money nobody paid.
    await billing.gift({
      apiKeyId: KEY_ID,
      amountUsd: '10',
      idempotencyKey: 'gift-typed',
      reason: 'welcome bonus',
    });
    await billing.settle({
      apiKeyId: KEY_ID,
      amountUsd: '1',
      idempotencyKey: 'charge-typed',
    });

    const entries = await billing.history(KEY_ID);
    const gift = entries.find((e) => e.entryType === 'gift');
    const charge = entries.find((e) => e.entryType === 'charge');

    expect(gift).toBeDefined();
    expect(charge).toBeDefined();
    expect(gift!.reason).toBe('welcome bonus');
    // The sign is what makes the arithmetic right; the type is what makes the
    // history auditable. Both must be correct.
    expect(gift!.amountUsd.toNumber()).toBeGreaterThan(0);
    expect(charge!.amountUsd.toNumber()).toBeLessThan(0);
  });

  it('does not gift twice for the same idempotency key', async () => {
    const first = await billing.gift({
      apiKeyId: KEY_ID,
      amountUsd: '50',
      idempotencyKey: 'gift-retried',
      reason: 'starting balance',
    });
    const second = await billing.gift({
      apiKeyId: KEY_ID,
      amountUsd: '50',
      idempotencyKey: 'gift-retried',
      reason: 'starting balance',
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(50);
    expect(await prisma.creditsLedger.count({ where: { idempotencyKey: 'gift-retried' } })).toBe(1);
  });

  it('does not gift twice when concurrent retries race', async () => {
    // The sequential case above would pass against a read-then-write check.
    // Firing together is what proves the DATABASE enforces it.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        billing
          .gift({
            apiKeyId: KEY_ID,
            amountUsd: '20',
            idempotencyKey: 'gift-raced',
            reason: 'starting balance',
          })
          .catch(() => false),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(20);
  });

  it('refuses a zero amount', async () => {
    // Zero adds nothing but would still burn an idempotency key, so a genuine
    // later gift under that key would be silently swallowed.
    await expect(
      billing.gift({
        apiKeyId: KEY_ID,
        amountUsd: '0',
        idempotencyKey: 'gift-zero',
        reason: 'nothing',
      }),
    ).rejects.toThrow(/greater than zero/);
  });

  it('refuses a negative amount', async () => {
    // A negative "gift" is a debit wearing a gift's label — it would take money
    // while appearing in the history as a grant.
    await expect(
      billing.gift({
        apiKeyId: KEY_ID,
        amountUsd: '-10',
        idempotencyKey: 'gift-negative',
        reason: 'clawback',
      }),
    ).rejects.toThrow(/greater than zero/);
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(0);
  });

  it('refuses a gift with no reason', async () => {
    // A gift is money appearing from nowhere; an auditor must find the answer
    // in the ledger, not in someone's memory.
    await expect(
      billing.gift({
        apiKeyId: KEY_ID,
        amountUsd: '5',
        idempotencyKey: 'gift-noreason',
        reason: '   ',
      }),
    ).rejects.toThrow(/reason/);
  });

  it('leaves a gifted balance spendable by an ordinary charge', async () => {
    // A gift that could not be spent would be a number on a screen.
    await billing.gift({
      apiKeyId: KEY_ID,
      amountUsd: '10',
      idempotencyKey: 'gift-spendable',
      reason: 'starting balance',
    });
    await billing.precheck(KEY_ID, new Prisma.Decimal('2'));
    await billing.settle({
      apiKeyId: KEY_ID,
      amountUsd: '2',
      idempotencyKey: 'spend-after-gift',
    });
    expect((await billing.balance(KEY_ID)).toNumber()).toBe(8);
  });
});
