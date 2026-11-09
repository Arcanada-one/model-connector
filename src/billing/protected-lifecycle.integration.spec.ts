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
import {
  PROTECTED_PHASE,
  classifyProtectedIntentReplay,
  isProtectedNonExpirePhase,
  protectedNonExpirePhases,
  protectedSettleablePhases,
  retainedProtectedResultHash,
} from './protected-lifecycle';

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

describe('P10-05 — nonterminal / corrupt settled replay refusals (PG)', () => {
  it('immutable phase views: mutating exports cannot make reserved settleable or drop unknown', async () => {
    const nonExpire = protectedNonExpirePhases() as string[];
    expect(() => {
      nonExpire.splice(nonExpire.indexOf(PROTECTED_PHASE.unknown), 1);
    }).toThrow();
    expect(isProtectedNonExpirePhase(PROTECTED_PHASE.unknown)).toBe(true);

    const settleable = protectedSettleablePhases() as string[];
    expect(() => {
      settleable.push(PROTECTED_PHASE.reserved);
    }).toThrow();
    expect(protectedSettleablePhases()).not.toContain(PROTECTED_PHASE.reserved);

    await fund(KEY_A, '5');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p1005-phase',
      payloadFingerprint: 'fp-p1005-phase',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;

    // reserved must still refuse settlement after the mutation attempts above.
    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '0.5',
        response: { leaked: true },
      }),
    ).toBe(false);

    expect(await billing.markProtectedUnknown(opened.intent)).toBe(true);
    const retry = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p1005-phase',
      payloadFingerprint: 'fp-p1005-phase',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(retry.outcome).toBe('protected_unknown');
    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row!.protectedPhase).toBe(PROTECTED_PHASE.unknown);
    expect(row!.state).toBe('held');
    expect((await billing.available(KEY_A)).toString()).toBe('4');
  });

  it('per-state refusals: reserved / dispatch_committed / unknown / corrupt settled / mismatch', async () => {
    await fund(KEY_A, '20');

    const cases: Array<{
      key: string;
      setup: (intentId: string) => Promise<void>;
      expected: 'in_flight' | 'protected_unknown' | 'not_replayable' | 'payload_mismatch';
      fingerprint?: string;
    }> = [
      {
        key: 'op-p1005-reserved',
        setup: async () => undefined,
        expected: 'in_flight',
      },
      {
        key: 'op-p1005-committed',
        setup: async () => undefined,
        expected: 'protected_unknown',
      },
      {
        key: 'op-p1005-unknown',
        setup: async () => undefined,
        expected: 'protected_unknown',
      },
      {
        key: 'op-p1005-corrupt',
        setup: async (intentId) => {
          await prisma.requestIntent.update({
            where: { id: intentId },
            data: {
              state: 'completed',
              protectedPhase: PROTECTED_PHASE.settled,
              completedAt: new Date(),
              response: Prisma.DbNull,
              requestId: 'req-corrupt',
            },
          });
        },
        expected: 'not_replayable',
      },
      {
        key: 'op-p1005-mismatch',
        setup: async () => undefined,
        expected: 'payload_mismatch',
        fingerprint: 'fp-WRONG',
      },
    ];

    for (const c of cases) {
      const opened = await billing.prepareProtectedReservation({
        apiKeyId: KEY_A,
        operationKey: c.key,
        payloadFingerprint: `fp-${c.key}`,
        providerName: 'mock',
        modelName: 'm',
        routeKey: 'r',
        pricePolicyRevision: 'catalog:x',
        holdUsd: '1',
      });
      expect(opened.outcome).toBe('opened');
      if (opened.outcome !== 'opened') return;

      if (c.key === 'op-p1005-committed') {
        expect(await billing.commitProtectedDispatch(opened.intent)).toBe(true);
      }
      if (c.key === 'op-p1005-unknown') {
        expect(await billing.commitProtectedDispatch(opened.intent)).toBe(true);
        expect(await billing.markProtectedUnknown(opened.intent)).toBe(true);
      }
      await c.setup(opened.intent.id);

      const before = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
      const availableBefore = await billing.available(KEY_A);

      const retry = await billing.prepareProtectedReservation({
        apiKeyId: KEY_A,
        operationKey: c.key,
        payloadFingerprint: c.fingerprint ?? `fp-${c.key}`,
        providerName: 'mock',
        modelName: 'm',
        routeKey: 'r',
        pricePolicyRevision: 'catalog:x',
        holdUsd: '1',
      });
      expect(retry.outcome).toBe(c.expected);
      expect(retry.outcome).not.toBe('replay');
      expect(retry.outcome).not.toBe('opened');

      const after = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
      expect(after!.intentKey).toBe(before!.intentKey);
      expect(after!.payloadFingerprint).toBe(before!.payloadFingerprint);
      expect(after!.holdUsd.toString()).toBe(before!.holdUsd.toString());
      expect(after!.reservationRef).toBe(before!.reservationRef);
      expect(after!.protectedPhase).toBe(before!.protectedPhase);
      expect((await billing.available(KEY_A)).toString()).toBe(availableBefore.toString());
    }
  });

  it('useful positive: settled matching hash is replay-eligible; recover unknown does not mint/release', async () => {
    await fund(KEY_A, '10');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p1005-settled',
      payloadFingerprint: 'fp-p1005-settled',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '2',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    expect(await billing.commitProtectedDispatch(opened.intent)).toBe(true);
    const body = { answer: 'retained' };
    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1.25',
        response: body,
        requestId: 'req-settled',
      }),
    ).toBe(true);

    const settledRow = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    const classified = classifyProtectedIntentReplay({
      row: settledRow!,
      payloadFingerprint: 'fp-p1005-settled',
      expectedResultHash: retainedProtectedResultHash(body)!,
    });
    expect(classified.kind).toBe('replay_eligible');
    if (classified.kind === 'replay_eligible') {
      expect(classified.marker).toBe('protected_settled_replay_eligible');
      expect(JSON.stringify(classified)).not.toContain('retained');
    }

    // M-P1005-RECOVER on a separate unknown row.
    const unk = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p1005-recover',
      payloadFingerprint: 'fp-p1005-recover',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(unk.outcome).toBe('opened');
    if (unk.outcome !== 'opened') return;
    expect(await billing.commitProtectedDispatch(unk.intent)).toBe(true);
    expect(await billing.markProtectedUnknown(unk.intent)).toBe(true);
    const before = await prisma.requestIntent.findUnique({ where: { id: unk.intent.id } });
    const availableBefore = await billing.available(KEY_A);

    const reopen = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-p1005-recover',
      payloadFingerprint: 'fp-p1005-recover',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
    });
    expect(reopen.outcome).toBe('protected_unknown');
    const after = await prisma.requestIntent.findUnique({ where: { id: unk.intent.id } });
    expect(after!.intentKey).toBe(before!.intentKey);
    expect(after!.reservationRef).toBe(before!.reservationRef);
    expect(after!.protectedPhase).toBe(PROTECTED_PHASE.unknown);
    expect(after!.state).toBe('held');
    expect((await billing.available(KEY_A)).toString()).toBe(availableBefore.toString());
  });
});

describe('P10-05 round 16 — classification vs legacy diverge on inconsistent completed rows (PG)', () => {
  /**
   * These rows make the legacy completed→replay path disagree with the
   * classifier. Without them M-CLASSIFY-OFF / M-INCOMPLETE-COMPLETEDAT /
   * M-UNKNOWN-PHASE-LEGACY survive every suite because fixtures stay on the
   * held path where both answers already match.
   */
  const retainedBody = { answer: 'stale-completed-bytes', private: true };

  async function forceInconsistentCompleted(params: {
    intentId: string;
    protectedPhase: string;
    completedAt: Date | null;
  }): Promise<void> {
    await prisma.requestIntent.update({
      where: { id: params.intentId },
      data: {
        state: 'completed',
        protectedPhase: params.protectedPhase,
        response: retainedBody,
        requestId: `req-inconsistent-${params.protectedPhase}`,
        completedAt: params.completedAt,
      },
    });
  }

  async function assertZeroSideEffects(params: {
    intentId: string;
    before: {
      intentKey: string;
      payloadFingerprint: string;
      holdUsd: string;
      reservationRef: string | null;
      protectedPhase: string | null;
      generation: number;
    };
    availableBefore: string;
    heldBefore: string;
    fetchCount: number;
    ledgerCountBefore: number;
  }): Promise<void> {
    expect(params.fetchCount).toBe(0);
    const after = await prisma.requestIntent.findUnique({ where: { id: params.intentId } });
    expect(after).not.toBeNull();
    expect(after!.intentKey).toBe(params.before.intentKey);
    expect(after!.payloadFingerprint).toBe(params.before.payloadFingerprint);
    expect(after!.holdUsd.toString()).toBe(params.before.holdUsd);
    expect(after!.reservationRef).toBe(params.before.reservationRef);
    expect(after!.protectedPhase).toBe(params.before.protectedPhase);
    expect(after!.generation).toBe(params.before.generation);
    expect(after!.state).toBe('completed');
    expect(after!.response).toEqual(retainedBody);
    expect((await billing.available(KEY_A)).toString()).toBe(params.availableBefore);
    const balance = await prisma.creditsBalance.findUnique({ where: { apiKeyId: KEY_A } });
    expect(balance!.heldUsd.toString()).toBe(params.heldBefore);
    const ledgerCountAfter = await prisma.creditsLedger.count({
      where: { apiKeyId: KEY_A },
    });
    expect(ledgerCountAfter).toBe(params.ledgerCountBefore);
    const intentCount = await prisma.requestIntent.count({
      where: { apiKeyId: KEY_A, intentKey: params.before.intentKey },
    });
    expect(intentCount).toBe(1);
  }

  function wrapFetch(): { getCount: () => number; restore: () => void } {
    let fetchCount = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCount += 1;
      if (typeof original === 'function') return original(...args);
      throw new Error('unexpected fetch in P10-05 inconsistent-row test');
    }) as typeof fetch;
    return {
      getCount: () => fetchCount,
      restore: () => {
        if (original) globalThis.fetch = original;
        else delete (globalThis as { fetch?: typeof fetch }).fetch;
      },
    };
  }

  it.each([
    {
      label: 'a-reserved',
      key: 'op-p1005-r16-a-reserved',
      phaseSetup: async (intent: Parameters<BillingService['commitProtectedDispatch']>[0]) => {
        await forceInconsistentCompleted({
          intentId: intent.id,
          protectedPhase: PROTECTED_PHASE.reserved,
          completedAt: new Date('2026-11-09T00:00:00Z'),
        });
      },
      expected: 'in_flight' as const,
    },
    {
      label: 'a-dispatch_committed',
      key: 'op-p1005-r16-a-committed',
      phaseSetup: async (intent: Parameters<BillingService['commitProtectedDispatch']>[0]) => {
        expect(await billing.commitProtectedDispatch(intent)).toBe(true);
        await forceInconsistentCompleted({
          intentId: intent.id,
          protectedPhase: PROTECTED_PHASE.dispatch_committed,
          completedAt: new Date('2026-11-09T00:00:00Z'),
        });
      },
      expected: 'protected_unknown' as const,
    },
    {
      label: 'a-unknown',
      key: 'op-p1005-r16-a-unknown',
      phaseSetup: async (intent: Parameters<BillingService['commitProtectedDispatch']>[0]) => {
        expect(await billing.commitProtectedDispatch(intent)).toBe(true);
        expect(await billing.markProtectedUnknown(intent)).toBe(true);
        await forceInconsistentCompleted({
          intentId: intent.id,
          protectedPhase: PROTECTED_PHASE.unknown,
          completedAt: new Date('2026-11-09T00:00:00Z'),
        });
      },
      expected: 'protected_unknown' as const,
    },
    {
      label: 'b-incomplete-completedAt',
      key: 'op-p1005-r16-b-incomplete',
      phaseSetup: async (intent: Parameters<BillingService['commitProtectedDispatch']>[0]) => {
        expect(await billing.commitProtectedDispatch(intent)).toBe(true);
        await forceInconsistentCompleted({
          intentId: intent.id,
          protectedPhase: PROTECTED_PHASE.settled,
          completedAt: null,
        });
      },
      expected: 'not_replayable' as const,
    },
    {
      label: 'c-unrecognised-phase',
      key: 'op-p1005-r16-c-bogus-phase',
      phaseSetup: async (intent: Parameters<BillingService['commitProtectedDispatch']>[0]) => {
        await forceInconsistentCompleted({
          intentId: intent.id,
          protectedPhase: 'phase_not_in_enum_v1',
          completedAt: new Date('2026-11-09T00:00:00Z'),
        });
      },
      expected: 'not_replayable' as const,
    },
  ])(
    'inconsistent completed row $label: prepare / openIntent / reopen refuse replay ($expected)',
    async ({ key, phaseSetup, expected }) => {
      await fund(KEY_A, '20');
      const fetch = wrapFetch();
      try {
        const opened = await billing.prepareProtectedReservation({
          apiKeyId: KEY_A,
          operationKey: key,
          payloadFingerprint: `fp-${key}`,
          providerName: 'mock',
          modelName: 'm',
          routeKey: 'r',
          pricePolicyRevision: 'catalog:x',
          holdUsd: '1',
        });
        expect(opened.outcome).toBe('opened');
        if (opened.outcome !== 'opened') return;

        await phaseSetup(opened.intent);

        const beforeRow = await prisma.requestIntent.findUnique({
          where: { id: opened.intent.id },
        });
        expect(beforeRow!.state).toBe('completed');
        expect(beforeRow!.response).toEqual(retainedBody);

        const availableBefore = (await billing.available(KEY_A)).toString();
        const heldBefore = (
          await prisma.creditsBalance.findUnique({ where: { apiKeyId: KEY_A } })
        )!.heldUsd.toString();
        const ledgerCountBefore = await prisma.creditsLedger.count({
          where: { apiKeyId: KEY_A },
        });
        const intentCountBefore = await prisma.requestIntent.count({
          where: { apiKeyId: KEY_A },
        });
        const before = {
          intentKey: beforeRow!.intentKey,
          payloadFingerprint: beforeRow!.payloadFingerprint,
          holdUsd: beforeRow!.holdUsd.toString(),
          reservationRef: beforeRow!.reservationRef,
          protectedPhase: beforeRow!.protectedPhase,
          generation: beforeRow!.generation,
        };

        // Same operation key / B replay via prepareProtectedReservation.
        const prepared = await billing.prepareProtectedReservation({
          apiKeyId: KEY_A,
          operationKey: key,
          payloadFingerprint: `fp-${key}`,
          providerName: 'mock',
          modelName: 'm',
          routeKey: 'r',
          pricePolicyRevision: 'catalog:x',
          holdUsd: '1',
        });
        expect(prepared.outcome).toBe(expected);
        expect(prepared.outcome).not.toBe('replay');
        expect(prepared.outcome).not.toBe('opened');
        if (prepared.outcome === 'replay') {
          expect.fail('must not return retained response bytes');
        }

        // Direct retry via openIntent.
        const direct = await billing.openIntent({
          apiKeyId: KEY_A,
          intentKey: key,
          clientSupplied: true,
          payloadFingerprint: `fp-${key}`,
          holdUsd: '1',
        });
        expect(direct.outcome).toBe(expected);
        expect(direct.outcome).not.toBe('replay');
        if (direct.outcome === 'replay') {
          expect.fail('openIntent must not return retained response bytes');
        }

        // Recover/reopen: a second prepare must still refuse and not mint/release.
        const reopen = await billing.prepareProtectedReservation({
          apiKeyId: KEY_A,
          operationKey: key,
          payloadFingerprint: `fp-${key}`,
          providerName: 'mock',
          modelName: 'm',
          routeKey: 'r',
          pricePolicyRevision: 'catalog:x',
          holdUsd: '1',
        });
        expect(reopen.outcome).toBe(expected);
        expect(reopen.outcome).not.toBe('replay');
        expect(reopen.outcome).not.toBe('opened');

        expect(await prisma.requestIntent.count({ where: { apiKeyId: KEY_A } })).toBe(
          intentCountBefore,
        );

        await assertZeroSideEffects({
          intentId: opened.intent.id,
          before,
          availableBefore,
          heldBefore,
          fetchCount: fetch.getCount(),
          ledgerCountBefore,
        });
      } finally {
        fetch.restore();
      }
    },
  );
});

describe('backstop — reserved → unknown when fence never ran', () => {
  it('markProtectedUnknown from reserved retains hold; release and sweeper lose', async () => {
    await fund(KEY_A, '5');
    const opened = await billing.prepareProtectedReservation({
      apiKeyId: KEY_A,
      operationKey: 'op-backstop',
      payloadFingerprint: 'fp-backstop',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1',
      ttlMs: 1,
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;

    // Simulate connector.execute returning without calling the dispatch hook.
    expect(await billing.markProtectedUnknown(opened.intent)).toBe(true);
    expect(opened.intent.protectedPhase).toBe(PROTECTED_PHASE.unknown);

    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const sweep = await billing.sweepExpiredIntents(100);
    expect(sweep.swept).toBe(0);
    expect(await billing.releaseIntent(opened.intent, 'released')).toBe(false);

    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row!.protectedPhase).toBe(PROTECTED_PHASE.unknown);
    expect(row!.state).toBe('held');
    expect((await billing.available(KEY_A)).toString()).toBe('4');
  });
});
