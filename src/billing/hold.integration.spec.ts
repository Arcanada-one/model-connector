/**
 * ARAS-0058 — the hold, against a REAL Postgres.
 *
 * The finding this spec exists for: `precheck()` was a plain `findUnique` and
 * `post()` an unguarded `increment` with a negative value. N parallel requests
 * on one balance all read it, all passed, all dispatched, all debited. `arcana`
 * IS a parallel agent, so that is the normal traffic shape and not an edge
 * case.
 *
 * Integration rather than unit, and not negotiable: the guarantee under test is
 * that Postgres re-evaluates a conditional UPDATE's predicate after taking the
 * row lock. A mocked Prisma would report whatever the mock was told to report,
 * so a unit test here could not fail even if the guard were deleted.
 *
 * Requires DATABASE_URL pointing at a migrated database (see
 * `pnpm test:integration`).
 */

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaService();
const billing = new BillingService(prisma);

const KEY_ID = '66666666-6666-4666-8666-666666666666';

/** The estimate for one request, and the whole of the account's money. */
const ONE_REQUEST_USD = '1.000000';

/** How hard we race it. Comfortably above MC's real concurrency ceiling. */
const K = 12;

async function resetAccount(): Promise<void> {
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

function openOne(n: number, holdUsd = ONE_REQUEST_USD) {
  return billing.openIntent({
    apiKeyId: KEY_ID,
    intentKey: `race-${n}-${Math.random()}`,
    clientSupplied: false,
    payloadFingerprint: 'fingerprint',
    holdUsd,
  });
}

beforeAll(async () => {
  await prisma.apiKey.upsert({
    where: { id: KEY_ID },
    create: { id: KEY_ID, name: 'aras-0058-hold-test', keyHash: `hash-${KEY_ID}` },
    update: {},
  });
});

beforeEach(resetAccount);

afterAll(async () => {
  await resetAccount();
  await prisma.apiKey.deleteMany({ where: { id: KEY_ID } });
  await prisma.$disconnect();
});

describe('the hold under concurrency', () => {
  it('admits exactly one of K simultaneous requests on a one-request balance', async () => {
    await fund(ONE_REQUEST_USD);

    const results = await Promise.all(Array.from({ length: K }, (_, n) => openOne(n)));

    const opened = results.filter((r) => r.outcome === 'opened');
    const refused = results.filter((r) => r.outcome === 'insufficient');

    expect(opened).toHaveLength(1);
    expect(refused).toHaveLength(K - 1);

    // And the refusal happened BEFORE any provider call — which is the whole
    // point. Nothing has been charged; the money is held, not spent.
    const balance = await billing.balance(KEY_ID);
    expect(balance.toString()).toBe('1');
    const available = await billing.available(KEY_ID);
    expect(available.toString()).toBe('0');
  });

  it('settles exactly one charge when K racers each try to settle', async () => {
    await fund('10');

    const opened = await Promise.all(Array.from({ length: K }, (_, n) => openOne(n, '1')));
    const handles = opened.flatMap((r) => (r.outcome === 'opened' ? [r.intent] : []));
    // A $10 balance covers ten $1 holds; the other two lose.
    expect(handles).toHaveLength(10);

    // Every racer now tries to settle the SAME intent — the shape a retry loop
    // or a duplicated worker produces.
    const target = handles[0];
    const settles = await Promise.all(
      Array.from({ length: K }, () =>
        billing.settleIntent({ intent: target, amountUsd: '0.25', requestId: undefined }),
      ),
    );
    expect(settles.filter(Boolean)).toHaveLength(1);

    const charges = await prisma.creditsLedger.findMany({
      where: { apiKeyId: KEY_ID, entryType: 'charge' },
    });
    expect(charges).toHaveLength(1);
    expect(new Prisma.Decimal(charges[0].amountUsd).toString()).toBe('-0.25');
  });

  it('never lets concurrent settlement drive the balance below zero', async () => {
    // The database's own floor, exercised rather than assumed. Ten holds of $1
    // against a $10 balance, each settling at $1: the arithmetic lands exactly
    // on zero, and any double-charge would cross it.
    await fund('10');
    const opened = await Promise.all(Array.from({ length: 10 }, (_, n) => openOne(n, '1')));
    const handles = opened.flatMap((r) => (r.outcome === 'opened' ? [r.intent] : []));
    expect(handles).toHaveLength(10);

    await Promise.all(handles.map((intent) => billing.settleIntent({ intent, amountUsd: '1' })));

    expect((await billing.balance(KEY_ID)).toString()).toBe('0');
    expect((await billing.available(KEY_ID)).toString()).toBe('0');
  });

  it('releases the hold when the request never becomes a charge', async () => {
    await fund('5');
    const result = await openOne(1, '2');
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;

    expect((await billing.available(KEY_ID)).toString()).toBe('3');

    expect(await billing.releaseIntent(result.intent)).toBe(true);
    expect((await billing.available(KEY_ID)).toString()).toBe('5');
    expect((await billing.balance(KEY_ID)).toString()).toBe('5');

    // Releasing twice must not hand the money back twice.
    expect(await billing.releaseIntent(result.intent)).toBe(false);
    expect((await billing.available(KEY_ID)).toString()).toBe('5');
  });

  it('refuses a hold on an account that has never been credited', async () => {
    const result = await openOne(1, '0.01');
    expect(result.outcome).toBe('insufficient');
  });

  it('still admits a zero-cost request on a zero balance', async () => {
    // A catalogued FREE model must stay callable on an empty account. This is
    // the ARAS-0064 behaviour, and reserving would have silently regressed it.
    const result = await openOne(1, '0');
    expect(result.outcome).toBe('opened');
  });

  it('sweeps a hold whose owner never came back', async () => {
    await fund('5');
    const result = await billing.openIntent({
      apiKeyId: KEY_ID,
      intentKey: `abandoned-${Math.random()}`,
      clientSupplied: false,
      payloadFingerprint: 'fingerprint',
      holdUsd: '2',
      ttlMs: -1, // already expired: the SIGKILL-between-reserve-and-settle case
    });
    expect(result.outcome).toBe('opened');
    expect((await billing.available(KEY_ID)).toString()).toBe('3');

    const { swept, releasedUsd } = await billing.sweepExpiredIntents();
    expect(swept).toBe(1);
    expect(releasedUsd).toBe('2');
    expect((await billing.available(KEY_ID)).toString()).toBe('5');

    // Idempotent: a second sweep finds nothing and returns nothing.
    expect((await billing.sweepExpiredIntents()).swept).toBe(0);
  });

  it('records an over-budget charge in full and writes off what it cannot collect', async () => {
    // The provider has already been paid by the time settlement runs, so a
    // charge is never allowed to fail — but the balance may not cover it. The
    // charge lands in full and the shortfall becomes an auditable write-off,
    // which is how `balance = SUM(ledger)` and `balance >= 0` stay true at once.
    await fund('1');
    const result = await openOne(1, '1');
    expect(result.outcome).toBe('opened');
    if (result.outcome !== 'opened') return;

    expect(await billing.settleIntent({ intent: result.intent, amountUsd: '3' })).toBe(true);

    expect((await billing.balance(KEY_ID)).toString()).toBe('0');

    const entries = await prisma.creditsLedger.findMany({ where: { apiKeyId: KEY_ID } });
    const sum = entries.reduce(
      (acc, e) => acc.plus(new Prisma.Decimal(e.amountUsd)),
      new Prisma.Decimal(0),
    );
    // The ledger still sums to the balance: nothing was hidden to make the
    // floor hold.
    expect(sum.toString()).toBe('0');

    const charge = entries.find((e) => e.entryType === 'charge');
    const writeOff = entries.find((e) => e.entryType === 'uncollectible');
    expect(new Prisma.Decimal(charge!.amountUsd).toString()).toBe('-3');
    expect(new Prisma.Decimal(writeOff!.amountUsd).toString()).toBe('2');
  });
});

describe('the advisory precheck', () => {
  it('is not a gate, and this spec exists so nobody mistakes it for one', async () => {
    // K concurrent prechecks against a one-request balance ALL pass, because a
    // read cannot reserve anything. This is the exact production bug: the
    // finding was not that precheck was wrong about the balance, it was that
    // being right about the balance is not the same as holding it. Anything
    // gating spend must call openIntent().
    await fund(ONE_REQUEST_USD);
    const outcomes = await Promise.all(
      Array.from({ length: K }, () =>
        billing.precheck(KEY_ID, ONE_REQUEST_USD).then(
          () => 'passed',
          () => 'refused',
        ),
      ),
    );
    expect(outcomes.filter((o) => o === 'passed')).toHaveLength(K);
  });
});
