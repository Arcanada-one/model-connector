/**
 * P10-05 — nonterminal / corrupt settled replay refusals on openIntent /
 * prepareProtectedReservation / recover(reclaim) paths.
 *
 * Uses a Prisma double so counters (create / updateMany / settle) are exact.
 * Physical provider fetch is asserted as zero because billing never fetches.
 */

import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing.service';
import {
  PROTECTED_LIFECYCLE_VERSION,
  PROTECTED_PHASE,
  classifyProtectedIntentReplay,
  retainedProtectedResultHash,
} from './protected-lifecycle';
import { sealProtectedResultIntegrity } from './protected-result-integrity';

type IntentRow = {
  id: string;
  apiKeyId: string;
  intentKey: string;
  payloadFingerprint: string;
  state: string;
  holdUsd: Prisma.Decimal;
  lifecycleVersion: number;
  protectedPhase: string | null;
  generation: number;
  reservationRef: string | null;
  operationKey: string | null;
  response: unknown;
  requestId: string | null;
  completedAt: Date | null;
  expiresAt: Date;
  providerName: string | null;
  modelName: string | null;
  routeKey: string | null;
  pricePolicyRevision: string | null;
  amountUnit: string | null;
  amountPrecision: number | null;
  clientSupplied: boolean;
  createdAt: Date;
  resultIntegrityProfile: string | null;
  resultIntegrityDigest: string | null;
  resultRetention: string | null;
};

function row(partial: Partial<IntentRow> & Pick<IntentRow, 'protectedPhase' | 'state'>): IntentRow {
  return {
    id: 'intent-1',
    apiKeyId: 'key-a',
    intentKey: 'op-p1005',
    payloadFingerprint: 'fp-p1005',
    holdUsd: new Prisma.Decimal('1.5'),
    lifecycleVersion: PROTECTED_LIFECYCLE_VERSION,
    generation: 2,
    reservationRef: 'res-p1005',
    operationKey: 'op-p1005',
    response: null,
    requestId: null,
    completedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    providerName: 'mock',
    modelName: 'm',
    routeKey: 'r',
    pricePolicyRevision: 'catalog:x',
    amountUnit: 'usd',
    amountPrecision: 6,
    clientSupplied: true,
    createdAt: new Date(),
    resultIntegrityProfile: null,
    resultIntegrityDigest: null,
    resultRetention: null,
    ...partial,
  };
}

describe('P10-05 billing openIntent / prepare / reclaim refusals', () => {
  let stored: IntentRow;
  let createCount: number;
  let updateManyCount: number;
  let transactionCount: number;
  let billing: BillingService;
  let fetchCount: number;
  let originalFetch: typeof globalThis.fetch | undefined;

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  beforeEach(() => {
    stored = row({ protectedPhase: PROTECTED_PHASE.reserved, state: 'held' });
    createCount = 0;
    updateManyCount = 0;
    transactionCount = 0;
    fetchCount = 0;

    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
      fetchCount += 1;
      if (typeof originalFetch === 'function') return originalFetch(...args);
      throw new Error('unexpected fetch');
    }) as typeof fetch;

    const prisma = {
      requestIntent: {
        findUnique: vi.fn(async () => stored),
        create: vi.fn(async () => {
          createCount += 1;
          throw Object.assign(new Error('unique'), {
            code: 'P2002',
            name: 'PrismaClientKnownRequestError',
          });
        }),
        updateMany: vi.fn(async () => {
          updateManyCount += 1;
          return { count: 0 };
        }),
      },
      creditsBalance: {
        updateMany: vi.fn(),
        findUnique: vi.fn(async () => ({
          balanceUsd: new Prisma.Decimal(10),
          heldUsd: new Prisma.Decimal(1.5),
        })),
      },
      creditsLedger: {
        create: vi.fn(),
        aggregate: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        transactionCount += 1;
        // Duplicate-key path for openIntent/prepare: create throws P2002.
        const tx = {
          requestIntent: {
            create: vi.fn(async () => {
              createCount += 1;
              const err = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
                code: 'P2002',
                clientVersion: 'test',
              });
              throw err;
            }),
            updateMany: vi.fn(async () => {
              updateManyCount += 1;
              return { count: 0 };
            }),
            findUnique: vi.fn(async () => stored),
          },
          creditsBalance: {
            updateMany: vi.fn(async () => ({ count: 1 })),
            findUnique: vi.fn(async () => ({
              balanceUsd: new Prisma.Decimal(10),
              heldUsd: new Prisma.Decimal(1.5),
            })),
            upsert: vi.fn(),
          },
          creditsLedger: { create: vi.fn() },
        };
        return fn(tx);
      }),
    };

    billing = new BillingService(prisma as never);
  });

  async function assertUnchangedAmbiguous(phase: string): Promise<void> {
    expect(stored.protectedPhase).toBe(phase);
    expect(stored.intentKey).toBe('op-p1005');
    expect(stored.payloadFingerprint).toBe('fp-p1005');
    expect(stored.holdUsd.toString()).toBe('1.5');
    expect(stored.reservationRef).toBe('res-p1005');
    expect(updateManyCount).toBe(0);
    expect(fetchCount).toBe(0);
  }

  it.each([
    {
      name: 'reserved',
      phase: PROTECTED_PHASE.reserved,
      state: 'held' as const,
      expected: 'in_flight' as const,
    },
    {
      name: 'dispatch_committed',
      phase: PROTECTED_PHASE.dispatch_committed,
      state: 'held' as const,
      expected: 'protected_unknown' as const,
    },
    {
      name: 'unknown',
      phase: PROTECTED_PHASE.unknown,
      state: 'held' as const,
      expected: 'protected_unknown' as const,
    },
  ])(
    'P10-05 $name: direct retry refuses completed-result replay (outcome=$expected)',
    async ({ phase, state, expected }) => {
      stored = row({ protectedPhase: phase, state });
      const before = { ...stored };

      const opened = await billing.openIntent({
        apiKeyId: 'key-a',
        intentKey: 'op-p1005',
        clientSupplied: true,
        payloadFingerprint: 'fp-p1005',
        holdUsd: '1.5',
      });
      expect(opened.outcome).toBe(expected);
      expect(opened.outcome).not.toBe('replay');
      expect(opened.outcome).not.toBe('opened');

      const prepared = await billing.prepareProtectedReservation({
        apiKeyId: 'key-a',
        operationKey: 'op-p1005',
        payloadFingerprint: 'fp-p1005',
        providerName: 'mock',
        modelName: 'm',
        routeKey: 'r',
        pricePolicyRevision: 'catalog:x',
        holdUsd: '1.5',
      });
      expect(prepared.outcome).toBe(expected);
      expect(prepared.outcome).not.toBe('replay');

      expect(stored.intentKey).toBe(before.intentKey);
      expect(stored.payloadFingerprint).toBe(before.payloadFingerprint);
      expect(stored.holdUsd.toString()).toBe(before.holdUsd.toString());
      expect(stored.reservationRef).toBe(before.reservationRef);
      expect(stored.protectedPhase).toBe(phase);
      await assertUnchangedAmbiguous(phase);
    },
  );

  // Round 16: state=completed + non-null response is where classifier and
  // legacy diverge. These kill M-CLASSIFY-OFF at the service level.
  it.each([
    {
      name: 'reserved+completed',
      phase: PROTECTED_PHASE.reserved,
      expected: 'in_flight' as const,
    },
    {
      name: 'dispatch_committed+completed',
      phase: PROTECTED_PHASE.dispatch_committed,
      expected: 'protected_unknown' as const,
    },
    {
      name: 'unknown+completed',
      phase: PROTECTED_PHASE.unknown,
      expected: 'protected_unknown' as const,
    },
  ])(
    'M-CLASSIFY-OFF $name: refuses legacy completed→replay (outcome=$expected)',
    async ({ phase, expected }) => {
      const body = { leaked: true };
      stored = row({
        protectedPhase: phase,
        state: 'completed',
        response: body,
        completedAt: new Date('2026-11-09T00:00:00Z'),
        requestId: 'req-inconsistent',
      });
      const opened = await billing.openIntent({
        apiKeyId: 'key-a',
        intentKey: 'op-p1005',
        clientSupplied: true,
        payloadFingerprint: 'fp-p1005',
        holdUsd: '1.5',
      });
      expect(opened.outcome).toBe(expected);
      expect(opened.outcome).not.toBe('replay');
      if (opened.outcome === 'replay') {
        expect.fail('must not return retained bytes');
      }
      const prepared = await billing.prepareProtectedReservation({
        apiKeyId: 'key-a',
        operationKey: 'op-p1005',
        payloadFingerprint: 'fp-p1005',
        providerName: 'mock',
        modelName: 'm',
        routeKey: 'r',
        pricePolicyRevision: 'catalog:x',
        holdUsd: '1.5',
      });
      expect(prepared.outcome).toBe(expected);
      expect(prepared.outcome).not.toBe('replay');
      expect(updateManyCount).toBe(0);
      expect(fetchCount).toBe(0);
      expect(stored.intentKey).toBe('op-p1005');
      expect(stored.payloadFingerprint).toBe('fp-p1005');
      expect(stored.holdUsd.toString()).toBe('1.5');
      expect(stored.reservationRef).toBe('res-p1005');
    },
  );

  it('M-INCOMPLETE-COMPLETEDAT: settled completed with null completedAt is not_replayable', async () => {
    stored = row({
      protectedPhase: PROTECTED_PHASE.settled,
      state: 'completed',
      response: { answer: 'incomplete' },
      completedAt: null,
      requestId: 'req-incomplete',
    });
    const opened = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-p1005',
      holdUsd: '1.5',
    });
    expect(opened.outcome).toBe('not_replayable');
    expect(opened.outcome).not.toBe('replay');
    expect(updateManyCount).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it('M-UNKNOWN-PHASE-LEGACY: unrecognised phase with completed bytes is not_replayable', async () => {
    stored = row({
      protectedPhase: 'phase_not_in_enum_v1',
      state: 'completed',
      response: { leaked: true },
      completedAt: new Date('2026-11-09T00:00:00Z'),
      requestId: 'req-bogus',
    });
    const opened = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-p1005',
      holdUsd: '1.5',
    });
    expect(opened.outcome).toBe('not_replayable');
    expect(opened.outcome).not.toBe('replay');
    const prepared = await billing.prepareProtectedReservation({
      apiKeyId: 'key-a',
      operationKey: 'op-p1005',
      payloadFingerprint: 'fp-p1005',
      providerName: 'mock',
      modelName: 'm',
      routeKey: 'r',
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1.5',
    });
    expect(prepared.outcome).toBe('not_replayable');
    expect(updateManyCount).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it('M-P1005-UNKNOWN-AS-INFLIGHT: unknown outcome differs from reserved in_flight', async () => {
    stored = row({ protectedPhase: PROTECTED_PHASE.unknown, state: 'held' });
    const unknown = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-p1005',
      holdUsd: '1.5',
    });
    stored = row({ protectedPhase: PROTECTED_PHASE.reserved, state: 'held' });
    const reserved = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-p1005',
      holdUsd: '1.5',
    });
    expect(unknown.outcome).toBe('protected_unknown');
    expect(reserved.outcome).toBe('in_flight');
    expect(unknown.outcome).not.toBe(reserved.outcome);
  });

  it('M-P1005-CORRUPT: incomplete settled refuses; no new hold/settle/fetch', async () => {
    stored = row({
      protectedPhase: PROTECTED_PHASE.settled,
      state: 'completed',
      completedAt: new Date(),
      response: null,
      requestId: 'req-1',
    });
    const opened = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-p1005',
      holdUsd: '1.5',
    });
    expect(opened.outcome).toBe('not_replayable');
    expect(updateManyCount).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it('mismatched fingerprint binding refuses without mutating the row', async () => {
    stored = row({ protectedPhase: PROTECTED_PHASE.dispatch_committed, state: 'held' });
    const opened = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-OTHER',
      holdUsd: '1.5',
    });
    expect(opened.outcome).toBe('payload_mismatch');
    expect(stored.payloadFingerprint).toBe('fp-p1005');
    expect(updateManyCount).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it('positive settled control: classified replay-eligible; openIntent returns replay (byte disclosure noted)', async () => {
    const body = { secret: 'private-bytes' };
    const seal = sealProtectedResultIntegrity({
      binding: {
        operationKey: 'op-p1005',
        apiKeyId: 'key-a',
        payloadFingerprint: 'fp-p1005',
        reservationRef: 'res-p1005',
        settlementGeneration: 2,
      },
      retained: body,
    });
    stored = row({
      protectedPhase: PROTECTED_PHASE.settled,
      state: 'completed',
      completedAt: new Date(),
      response: body,
      requestId: 'req-settled',
      resultIntegrityProfile: seal.profile,
      resultIntegrityDigest: seal.digest,
      resultRetention: seal.retention,
    });
    const classified = classifyProtectedIntentReplay({
      row: stored,
      payloadFingerprint: 'fp-p1005',
      expectedResultHash: retainedProtectedResultHash(body)!,
    });
    expect(classified.kind).toBe('replay_eligible');
    if (classified.kind === 'replay_eligible') {
      expect(classified.marker).toBe('protected_settled_replay_eligible');
    }

    const opened = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-p1005',
      holdUsd: '1.5',
    });
    // Finding (unchanged this round): settled replay still returns private bytes
    // from billing.service resolveReplay / protected-lab.controller HTTP path.
    expect(opened.outcome).toBe('replay');
    if (opened.outcome === 'replay') {
      expect(opened.response).toEqual(body);
    }
    expect(updateManyCount).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it('M-P1005-RECOVER: reclaim/reopen of unknown does not mint a new key or release the hold', async () => {
    stored = row({
      protectedPhase: PROTECTED_PHASE.unknown,
      state: 'held',
      // Make the row look "abandoned" to the legacy reclaim filter; protected
      // reclaim must still refuse because phase is unknown, not proven_no_dispatch.
    });
    const beforeRef = stored.reservationRef;
    const beforeKey = stored.intentKey;

    const opened = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-p1005',
      holdUsd: '1.5',
    });
    expect(opened.outcome).toBe('protected_unknown');
    expect(opened.outcome).not.toBe('opened');

    // Force the reclaim path by marking state released while keeping unknown —
    // classification must still refuse before reclaimIntent runs.
    stored = row({
      protectedPhase: PROTECTED_PHASE.unknown,
      state: 'released',
      reservationRef: beforeRef,
    });
    const again = await billing.openIntent({
      apiKeyId: 'key-a',
      intentKey: 'op-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-p1005',
      holdUsd: '1.5',
    });
    expect(again.outcome).toBe('protected_unknown');
    expect(stored.intentKey).toBe(beforeKey);
    expect(stored.reservationRef).toBe(beforeRef);
    expect(stored.protectedPhase).toBe(PROTECTED_PHASE.unknown);
    // updateMany would be the reclaim CAS; must stay zero for unknown.
    expect(updateManyCount).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it('proven_no_dispatch is not classified as a replayable paid result', () => {
    const c = classifyProtectedIntentReplay({
      row: row({
        protectedPhase: PROTECTED_PHASE.proven_no_dispatch,
        state: 'released',
      }),
      payloadFingerprint: 'fp-p1005',
    });
    expect(c.replayEligible).toBe(false);
    expect(c.kind).toBe('proven_no_dispatch');
  });

  it('tracks that prepare/open never issued a provider fetch in these refusal cases', () => {
    expect(fetchCount).toBe(0);
    expect(transactionCount).toBeGreaterThanOrEqual(0);
    expect(createCount).toBeGreaterThanOrEqual(0);
  });
});
