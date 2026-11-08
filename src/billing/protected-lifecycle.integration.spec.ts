/**
 * Protected Lab reservation lifecycle — acceptance controls P1–P4, P6–P8, P11.
 *
 * Requires DATABASE_URL pointing at a migrated database.
 * No real provider keys; no network calls to providers.
 */

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { PROTECTED_PHASE } from './protected-lifecycle';

const prisma = new PrismaService();
const billing = new BillingService(prisma);

const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function reset(): Promise<void> {
  await prisma.requestIntent.deleteMany({ where: { apiKeyId: { in: [KEY_A, KEY_B] } } });
  await prisma.creditsLedger.deleteMany({ where: { apiKeyId: { in: [KEY_A, KEY_B] } } });
  await prisma.creditsBalance.deleteMany({ where: { apiKeyId: { in: [KEY_A, KEY_B] } } });
}

async function fund(apiKeyId: string, amountUsd: string): Promise<void> {
  await billing.credit({
    apiKeyId,
    amountUsd,
    idempotencyKey: `fund-${apiKeyId}-${Math.random()}`,
    reason: 'protected lifecycle test funding',
  });
}

beforeAll(async () => {
  for (const id of [KEY_A, KEY_B]) {
    await prisma.apiKey.upsert({
      where: { id },
      create: { id, name: `protected-${id}`, keyHash: `hash-${id}` },
      update: {},
    });
  }
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await prisma.apiKey.deleteMany({ where: { id: { in: [KEY_A, KEY_B] } } });
  await prisma.$disconnect();
});

describe('P1 — protected prepare refuses unknown pricing / unpinned zero (null-intent class)', () => {
  it('refuses prepare without a pinned price-policy revision', async () => {
    await fund(KEY_A, '10');
    const result = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p1-unknown-price',
      payloadFingerprint: 'fp-1',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: '',
      holdUsd: '1',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('protected_price_unknown');
  });

  it('positive control: pinned paid policy opens a reserved hold', async () => {
    await fund(KEY_A, '10');
    const result = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p1-paid',
      payloadFingerprint: 'fp-paid',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:2026-11-08',
      holdUsd: '1.5',
    });
    expect(result.outcome).toBe('opened');
    if (result.outcome === 'opened') {
      expect(result.reservation.protectedPhase).toBe(PROTECTED_PHASE.reserved);
      expect(result.reservation.reservationRef).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result.intent.lifecycleVersion).toBe(1);
    }
  });
});

describe('P2 — wrong account / key / payload / reservation_ref refuses', () => {
  it('lookup with the wrong API key is forbidden', async () => {
    await fund(KEY_A, '5');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p2',
      payloadFingerprint: 'fp-p2',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    const looked = await billing.lookupProtectedReservation({
      reservationRef: opened.reservation.reservationRef,
      apiKeyId: KEY_B,
    });
    expect(looked.outcome).toBe('forbidden');
  });

  it('positive control: owning key resolves the binding', async () => {
    await fund(KEY_A, '5');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p2-ok',
      payloadFingerprint: 'fp-p2-ok',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    const looked = await billing.lookupProtectedReservation({
      reservationRef: opened.reservation.reservationRef,
      apiKeyId: KEY_A,
    });
    expect(looked.outcome).toBe('found');
    if (looked.outcome === 'found') {
      expect(looked.reservation.payloadFingerprint).toBe('fp-p2-ok');
    }
  });

  it('mismatched reservation_ref is not_found', async () => {
    const looked = await billing.lookupProtectedReservation({
      reservationRef: '00000000-0000-4000-8000-000000000099',
      apiKeyId: KEY_A,
    });
    expect(looked.outcome).toBe('not_found');
  });
});

describe('P3 — insufficient balance and concurrent reservations keep the budget intact', () => {
  it('admits exactly one of K concurrent protected prepares on a one-request balance', async () => {
    await fund(KEY_A, '1');
    const K = 8;
    const results = await Promise.all(
      Array.from({ length: K }, (_, n) =>
        billing.prepareProtectedReservation({
          apiKeyId: KEY_A,
          operationKey: `op-p3-${n}-${Math.random()}`,
          payloadFingerprint: `fp-${n}`,
          providerName: 'mock',
          modelName: 'm',
          routeKey: 'r',
          pricePolicyRevision: 'catalog:x',
          holdUsd: '1',
        }),
      ),
    );
    expect(results.filter((r) => r.outcome === 'opened')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'insufficient')).toHaveLength(K - 1);
    const available = await billing.available(KEY_A);
    expect(available.toString()).toBe('0');
    const balance = await billing.balance(KEY_A);
    expect(balance.toString()).toBe('1');
  });
});

describe('P4 — positively priced-zero and valid paid both work', () => {
  it('zero hold under zero: pinned policy opens without balance', async () => {
    const result = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p4-zero',
      payloadFingerprint: 'fp-zero',
      providerName: 'mock',
      modelName: 'free-m',
      routeKey: 'r',
      pricePolicyRevision: 'zero:catalog-free-2026-11-08',
      holdUsd: '0',
    });
    expect(result.outcome).toBe('opened');
  });

  it('unpinned zero hold refuses', async () => {
    const result = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p4-zero-bad',
      payloadFingerprint: 'fp-zero-bad',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:unknown-free',
      holdUsd: '0',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('protected_zero_unpinned');
  });

  it('paid hold opens and settles exactly once', async () => {
    await fund(KEY_A, '10');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p4-paid',
      payloadFingerprint: 'fp-paid',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '2',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    expect(await billing.commitProtectedDispatch(opened.intent)).toBe(true);
    const settled = await billing.settleIntent({
      intent: opened.intent,
      amountUsd: '1.25',
      response: { ok: true },
    });
    expect(settled).toBe(true);
    const again = await billing.settleIntent({
      intent: opened.intent,
      amountUsd: '1.25',
      response: { ok: true },
    });
    expect(again).toBe(false);
  });
});

describe('P6 — sweeper vs dispatch commit: exactly one wins', () => {
  it('CAS race: commit and expire; exactly one succeeds', async () => {
    await fund(KEY_A, '5');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p6',
      payloadFingerprint: 'fp-p6',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
      ttlMs: 1,
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;

    // Force expiry in the past so the sweeper is eligible.
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const [commitWon, sweep] = await Promise.all([
      billing.commitProtectedDispatch(opened.intent),
      billing.sweepExpiredIntents(100),
    ]);

    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row).toBeTruthy();
    if (commitWon) {
      expect(sweep.swept).toBe(0);
      expect(row!.protectedPhase).toBe(PROTECTED_PHASE.dispatch_committed);
      expect(row!.state).toBe('held');
    } else {
      expect(sweep.swept).toBe(1);
      expect(row!.protectedPhase).toBe(PROTECTED_PHASE.proven_no_dispatch);
      expect(row!.state).toBe('expired');
    }
  });
});

describe('P7 — after commit, timeout/crash stays unknown; no release/reclaim/new key', () => {
  it('markUnknown retains the hold; reclaim refuses; sweeper skips', async () => {
    await fund(KEY_A, '5');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p7',
      payloadFingerprint: 'fp-p7',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
      ttlMs: 1,
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;

    expect(await billing.commitProtectedDispatch(opened.intent)).toBe(true);
    expect(await billing.markProtectedUnknown(opened.intent)).toBe(true);

    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const sweep = await billing.sweepExpiredIntents(100);
    expect(sweep.swept).toBe(0);

    const released = await billing.releaseIntent(opened.intent, 'released');
    expect(released).toBe(false);

    const replay = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-p7',
      clientSupplied: true,
      payloadFingerprint: 'fp-p7',
      holdUsd: '1',
    });
    expect(replay.outcome).toBe('protected_unknown');

    const available = await billing.available(KEY_A);
    expect(available.toString()).toBe('4');
  });
});

describe('P8 — late result vs settle/release charges exactly once', () => {
  it('settle and release race after commit: exactly one charge', async () => {
    await fund(KEY_A, '10');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p8',
      payloadFingerprint: 'fp-p8',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '2',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    expect(await billing.commitProtectedDispatch(opened.intent)).toBe(true);

    const [a, b] = await Promise.all([
      billing.settleIntent({ intent: opened.intent, amountUsd: '1.5', response: { n: 1 } }),
      billing.settleIntent({ intent: opened.intent, amountUsd: '1.5', response: { n: 2 } }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);

    // Release after commit must lose.
    expect(await billing.releaseIntent(opened.intent)).toBe(false);

    const balance = await billing.balance(KEY_A);
    // 10 funded - 1.5 charged = 8.5
    expect(new Prisma.Decimal(balance).toFixed(6)).toBe('8.500000');
  });
});

describe('P11 — hidden retry / failover cannot bypass the fence', () => {
  it('dispatch_committed cannot be reclaimed under a new prepare of the same key', async () => {
    await fund(KEY_A, '10');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p11',
      payloadFingerprint: 'fp-p11',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    expect(await billing.commitProtectedDispatch(opened.intent)).toBe(true);

    const retry = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p11',
      payloadFingerprint: 'fp-p11',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(retry.outcome).toBe('protected_unknown');
  });

  it('positive control: pre-commit release (proven_no_dispatch) allows a later fresh prepare', async () => {
    await fund(KEY_A, '10');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p11-ok',
      payloadFingerprint: 'fp-p11-ok',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    expect(await billing.releaseIntent(opened.intent)).toBe(true);

    const again = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p11-ok',
      payloadFingerprint: 'fp-p11-ok',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(again.outcome).toBe('opened');
  });
});

describe('legacy rows unchanged', () => {
  it('legacy openIntent still uses held without protected phase', async () => {
    await fund(KEY_A, '5');
    const opened = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'legacy-1',
      clientSupplied: true,
      payloadFingerprint: 'fp-legacy',
      holdUsd: '1',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row?.lifecycleVersion).toBe(0);
    expect(row?.protectedPhase).toBeNull();
    expect(row?.state).toBe('held');
    expect(await billing.releaseIntent(opened.intent)).toBe(true);
  });
});
