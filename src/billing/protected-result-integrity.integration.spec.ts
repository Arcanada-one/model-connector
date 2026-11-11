/**
 * RI01–RI10 — retained integrity for protected settled results (PG16).
 *
 * Throw-away database only. Synthetic results; mocked fetch. Real connections.
 * RI01 and RI07 reopen through a new Prisma connection.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

/** Fresh Prisma connection for RI01/RI07 reopen requirements. */
function openFreshClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({ adapter });
}
import { PROTECTED_PHASE, classifyProtectedIntentReplay } from './protected-lifecycle';
import {
  INTEGRITY_REFUSAL_REASON,
  PROTECTED_RESULT_INTEGRITY_PROFILE,
  RESULT_RETENTION,
  computeProtectedResultIntegrityDigest,
  priV1CanonicalJson,
} from './protected-result-integrity';
import { MAX_REPLAYABLE_RESPONSE_BYTES } from './intent';

const prisma = new PrismaService();
const billing = new BillingService(prisma);

const KEY_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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
    reason: 'ri integrity test funding',
  });
}

async function prepareAndCommit(params: {
  apiKeyId: string;
  operationKey: string;
  payloadFingerprint: string;
  holdUsd?: string;
}) {
  const opened = await billing.prepareProtectedReservation({
    apiKeyId: params.apiKeyId,
    operationKey: params.operationKey,
    payloadFingerprint: params.payloadFingerprint,
    providerName: 'mock',
    modelName: 'm',
    routeKey: 'r',
    pricePolicyRevision: 'catalog:ri',
    holdUsd: params.holdUsd ?? '1.5',
  });
  expect(opened.outcome).toBe('opened');
  if (opened.outcome !== 'opened') throw new Error('prepare failed');
  expect(await billing.commitProtectedDispatch(opened.intent)).toBe(true);
  return opened;
}

beforeAll(async () => {
  for (const id of [KEY_A, KEY_B]) {
    await prisma.apiKey.upsert({
      where: { id },
      create: { id, name: `ri-${id}`, keyHash: `hash-${id}` },
      update: {},
    });
  }
});

beforeEach(async () => {
  await reset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('RI suite must not call real providers');
    }),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await reset();
  await prisma.apiKey.deleteMany({ where: { id: { in: [KEY_A, KEY_B] } } });
  await prisma.$disconnect();
});

describe('RI01 — settle, reopen, verify exact retained JSON; one charge', () => {
  it('positive: settle, reopen via new connection, exact JSON identity, one settlement/charge', async () => {
    await fund(KEY_A, '20');
    const body = { z: 1, a: { nested: ['x', 'é'], n: null }, flag: true };
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri01',
      payloadFingerprint: 'fp-ri01',
    });

    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1.25',
        response: body,
        requestId: 'req-ri01',
      }),
    ).toBe(true);

    const ledgerCount = await prisma.creditsLedger.count({
      where: { apiKeyId: KEY_A, entryType: 'charge' },
    });
    expect(ledgerCount).toBe(1);

    // Reopen through a new connection (RI01 requirement).
    const fresh = openFreshClient();
    try {
      const row = await fresh.requestIntent.findUnique({ where: { id: opened.intent.id } });
      expect(row).not.toBeNull();
      expect(row!.protectedPhase).toBe(PROTECTED_PHASE.settled);
      expect(row!.resultRetention).toBe(RESULT_RETENTION.retained);
      expect(row!.resultIntegrityProfile).toBe(PROTECTED_RESULT_INTEGRITY_PROFILE);
      expect(row!.resultIntegrityDigest).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
      expect(priV1CanonicalJson(row!.response)).toBe(priV1CanonicalJson(body));

      const freshBilling = new BillingService(fresh as unknown as PrismaService);
      const replay = await freshBilling.openIntent({
        apiKeyId: KEY_A,
        intentKey: 'op-ri01',
        clientSupplied: true,
        payloadFingerprint: 'fp-ri01',
        holdUsd: '1.5',
      });
      expect(replay.outcome).toBe('replay');
      if (replay.outcome === 'replay') {
        expect(priV1CanonicalJson(replay.response)).toBe(priV1CanonicalJson(body));
      }

      // Second settle does not charge again.
      expect(
        await billing.settleIntent({
          intent: opened.intent,
          amountUsd: '1.25',
          response: body,
        }),
      ).toBe(false);
      expect(
        await prisma.creditsLedger.count({
          where: { apiKeyId: KEY_A, entryType: 'charge' },
        }),
      ).toBe(1);
    } finally {
      await fresh.$disconnect();
    }
  });
});

describe('RI02 — stored response changed, digest kept', () => {
  it('refuses before disclosure; zero new effects', async () => {
    await fund(KEY_A, '10');
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri02',
      payloadFingerprint: 'fp-ri02',
    });
    const body = { answer: 'original' };
    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1',
        response: body,
        requestId: 'req-ri02',
      }),
    ).toBe(true);

    const before = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    const ledgerBefore = await prisma.creditsLedger.count({ where: { apiKeyId: KEY_A } });
    const availableBefore = await billing.available(KEY_A);

    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { response: { answer: 'tampered' } as Prisma.InputJsonValue },
    });

    const replay = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri02',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri02',
      holdUsd: '1.5',
    });
    expect(replay.outcome).toBe('integrity_refused');
    if (replay.outcome === 'integrity_refused') {
      expect(replay.reason).toBe(INTEGRITY_REFUSAL_REASON.integrity_digest_mismatch);
    }

    const after = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(after!.resultIntegrityDigest).toBe(before!.resultIntegrityDigest);
    expect(after!.reservationRef).toBe(before!.reservationRef);
    expect(after!.generation).toBe(before!.generation);
    expect(await prisma.creditsLedger.count({ where: { apiKeyId: KEY_A } })).toBe(ledgerBefore);
    expect((await billing.available(KEY_A)).toString()).toBe(availableBefore.toString());
  });
});

describe('RI03 — foreign integrity record substituted', () => {
  it('binding refusal when another operation digest is copied onto the row', async () => {
    await fund(KEY_A, '20');
    const body = { same: 'text' };
    const a = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri03-a',
      payloadFingerprint: 'fp-ri03-a',
    });
    const b = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri03-b',
      payloadFingerprint: 'fp-ri03-b',
    });
    expect(
      await billing.settleIntent({
        intent: a.intent,
        amountUsd: '1',
        response: body,
        requestId: 'req-ri03-a',
      }),
    ).toBe(true);
    expect(
      await billing.settleIntent({
        intent: b.intent,
        amountUsd: '1',
        response: body,
        requestId: 'req-ri03-b',
      }),
    ).toBe(true);

    const rowB = await prisma.requestIntent.findUnique({ where: { id: b.intent.id } });
    await prisma.requestIntent.update({
      where: { id: a.intent.id },
      data: {
        resultIntegrityDigest: rowB!.resultIntegrityDigest,
        resultIntegrityProfile: rowB!.resultIntegrityProfile,
        resultRetention: rowB!.resultRetention,
      },
    });

    const replay = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri03-a',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri03-a',
      holdUsd: '1.5',
    });
    expect(replay.outcome).toBe('integrity_refused');
    if (replay.outcome === 'integrity_refused') {
      expect(replay.reason).toBe(INTEGRITY_REFUSAL_REASON.integrity_binding_mismatch);
    }
  });
});

/**
 * RI03 per-field: each sealed binding column must independently refuse when
 * altered while response + stored digest stay put. Whole-digest substitution
 * alone leaves single-field contribution unmeasured (MV-BIND-NO-*).
 *
 * For columns that also gate the earlier classifier checks (operation_key /
 * payload_fingerprint / api_key_id), the replay request matches the altered
 * column so only the sealed binding refuses.
 */
describe('RI03 per-field — each binding column refuses alone', () => {
  async function settleFixture(op: string, fp: string) {
    await fund(KEY_A, '20');
    await fund(KEY_B, '5');
    const body = { retained: op };
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: op,
      payloadFingerprint: fp,
    });
    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1',
        response: body,
        requestId: `req-${op}`,
      }),
    ).toBe(true);
    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row!.resultIntegrityDigest).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
    return { opened, body, row: row! };
  }

  async function assertBindingRefuseNoEffects(params: {
    intentId: string;
    apiKeyId: string;
    intentKey: string;
    payloadFingerprint: string;
    /** Columns we deliberately changed; remaining integrity columns must hold. */
    digestBefore: string | null;
    responseBefore: unknown;
  }) {
    const ledgerABefore = await prisma.creditsLedger.count({ where: { apiKeyId: KEY_A } });
    const ledgerBBefore = await prisma.creditsLedger.count({ where: { apiKeyId: KEY_B } });
    const availableABefore = await billing.available(KEY_A);
    const availableBBefore = await billing.available(KEY_B);
    const before = await prisma.requestIntent.findUnique({ where: { id: params.intentId } });

    const replay = await billing.openIntent({
      apiKeyId: params.apiKeyId,
      intentKey: params.intentKey,
      clientSupplied: true,
      payloadFingerprint: params.payloadFingerprint,
      holdUsd: '1.5',
    });
    expect(replay.outcome).toBe('integrity_refused');
    if (replay.outcome === 'integrity_refused') {
      expect(replay.reason).toBe(INTEGRITY_REFUSAL_REASON.integrity_binding_mismatch);
    }
    expect(replay).not.toHaveProperty('response');

    const after = await prisma.requestIntent.findUnique({ where: { id: params.intentId } });
    expect(after!.resultIntegrityDigest).toBe(params.digestBefore);
    expect(priV1CanonicalJson(after!.response)).toBe(priV1CanonicalJson(params.responseBefore));
    expect(after!.resultRetention).toBe(before!.resultRetention);
    expect(after!.resultIntegrityProfile).toBe(before!.resultIntegrityProfile);
    expect(await prisma.creditsLedger.count({ where: { apiKeyId: KEY_A } })).toBe(ledgerABefore);
    expect(await prisma.creditsLedger.count({ where: { apiKeyId: KEY_B } })).toBe(ledgerBBefore);
    expect((await billing.available(KEY_A)).toString()).toBe(availableABefore.toString());
    expect((await billing.available(KEY_B)).toString()).toBe(availableBBefore.toString());
  }

  it('operation_key alone → integrity_binding_mismatch', async () => {
    const { opened, body, row } = await settleFixture('op-ri03-opkey', 'fp-ri03-opkey');
    const alteredOp = 'op-ri03-opkey-altered';
    // intent_key is the lookup identity (not hashed). Align it with the altered
    // operation_key so the classifier's early op-key check passes and only the
    // sealed binding refuses — same shape as the fingerprint case below.
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { operationKey: alteredOp, intentKey: alteredOp },
    });
    await assertBindingRefuseNoEffects({
      intentId: opened.intent.id,
      apiKeyId: KEY_A,
      intentKey: alteredOp,
      payloadFingerprint: 'fp-ri03-opkey',
      digestBefore: row.resultIntegrityDigest,
      responseBefore: body,
    });
  });

  it('api_key_id alone → integrity_binding_mismatch', async () => {
    const { opened, body, row } = await settleFixture('op-ri03-apikey', 'fp-ri03-apikey');
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { apiKeyId: KEY_B },
    });
    await assertBindingRefuseNoEffects({
      intentId: opened.intent.id,
      apiKeyId: KEY_B,
      intentKey: 'op-ri03-apikey',
      payloadFingerprint: 'fp-ri03-apikey',
      digestBefore: row.resultIntegrityDigest,
      responseBefore: body,
    });
  });

  it('reservation_ref alone → integrity_binding_mismatch', async () => {
    const { opened, body, row } = await settleFixture('op-ri03-resref', 'fp-ri03-resref');
    const foreignRef = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { reservationRef: foreignRef },
    });
    await assertBindingRefuseNoEffects({
      intentId: opened.intent.id,
      apiKeyId: KEY_A,
      intentKey: 'op-ri03-resref',
      payloadFingerprint: 'fp-ri03-resref',
      digestBefore: row.resultIntegrityDigest,
      responseBefore: body,
    });
  });

  it('payload_fingerprint alone → integrity_binding_mismatch', async () => {
    const { opened, body, row } = await settleFixture('op-ri03-fp', 'fp-ri03-fp');
    const alteredFp = 'fp-ri03-fp-altered';
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { payloadFingerprint: alteredFp },
    });
    // Replay fingerprint matches the altered column so the earlier fingerprint
    // check passes; only the sealed binding refuses.
    await assertBindingRefuseNoEffects({
      intentId: opened.intent.id,
      apiKeyId: KEY_A,
      intentKey: 'op-ri03-fp',
      payloadFingerprint: alteredFp,
      digestBefore: row.resultIntegrityDigest,
      responseBefore: body,
    });
  });

  it('generation alone → integrity_binding_mismatch', async () => {
    const { opened, body, row } = await settleFixture('op-ri03-gen', 'fp-ri03-gen');
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { generation: row.generation + 7 },
    });
    await assertBindingRefuseNoEffects({
      intentId: opened.intent.id,
      apiKeyId: KEY_A,
      intentKey: 'op-ri03-gen',
      payloadFingerprint: 'fp-ri03-gen',
      digestBefore: row.resultIntegrityDigest,
      responseBefore: body,
    });
  });
});

describe('CAS seal generation — concurrent bump without expected generation', () => {
  it('settle loses CAS when generation bumps between read and write; no mismatched seal', async () => {
    await fund(KEY_A, '10');
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri-cas-gen',
      payloadFingerprint: 'fp-ri-cas-gen',
    });
    const genAtCommit = opened.intent.generation;
    expect(genAtCommit).toBeTypeOf('number');

    const ledgerBefore = await prisma.creditsLedger.count({
      where: { apiKeyId: KEY_A, entryType: 'charge' },
    });

    // Omit expected generation so the pre-CAS fence does not hide the race;
    // the CAS itself must still constrain current.generation from the seal read.
    const intentWithoutExpectedGen = {
      id: opened.intent.id,
      apiKeyId: opened.intent.apiKeyId,
      intentKey: opened.intent.intentKey,
      holdUsd: opened.intent.holdUsd,
      lifecycleVersion: opened.intent.lifecycleVersion,
      protectedPhase: opened.intent.protectedPhase,
      reservationRef: opened.intent.reservationRef,
    };

    let bumped = false;
    const realSettleInTx = billing.settleIntentInTx.bind(billing);
    const wrapSpy = vi.spyOn(billing, 'settleIntentInTx').mockImplementation(async (tx, params) => {
      const originalFind = tx.requestIntent.findUnique.bind(tx.requestIntent);
      tx.requestIntent.findUnique = (async (args: unknown) => {
        const row = await originalFind(args as never);
        if (
          !bumped &&
          row &&
          typeof row === 'object' &&
          'id' in row &&
          (row as { id: string }).id === opened.intent.id
        ) {
          bumped = true;
          // Concurrent writer on a separate connection (Read Committed): bump
          // generation after the unlocked seal read, before the CAS write.
          await prisma.requestIntent.update({
            where: { id: opened.intent.id },
            data: { generation: { increment: 1 } },
          });
        }
        return row;
      }) as typeof tx.requestIntent.findUnique;
      try {
        return await realSettleInTx(tx, params);
      } finally {
        tx.requestIntent.findUnique = originalFind;
      }
    });

    const settled = await billing.settleIntent({
      intent: intentWithoutExpectedGen,
      amountUsd: '1',
      response: { should: 'not-seal-mismatched' },
      requestId: 'req-ri-cas-gen',
    });
    wrapSpy.mockRestore();

    expect(bumped).toBe(true);
    expect(settled).toBe(false);

    const after = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(after!.protectedPhase).toBe(PROTECTED_PHASE.dispatch_committed);
    expect(after!.response).toBeNull();
    expect(after!.resultIntegrityDigest).toBeNull();
    expect(after!.resultIntegrityProfile).toBeNull();
    expect(after!.resultRetention).toBeNull();
    // Concurrent bump landed; settle did not increment further.
    expect(after!.generation).toBe((genAtCommit as number) + 1);
    expect(
      await prisma.creditsLedger.count({
        where: { apiKeyId: KEY_A, entryType: 'charge' },
      }),
    ).toBe(ledgerBefore);
  });
});

describe('RI04 — missing / malformed / unsupported / historical', () => {
  it('exact typed reason each; no on-read backfill', async () => {
    await fund(KEY_A, '30');
    const body = { v: 1 };

    async function settleNamed(op: string) {
      const opened = await prepareAndCommit({
        apiKeyId: KEY_A,
        operationKey: op,
        payloadFingerprint: `fp-${op}`,
      });
      expect(
        await billing.settleIntent({
          intent: opened.intent,
          amountUsd: '1',
          response: body,
          requestId: `req-${op}`,
        }),
      ).toBe(true);
      return opened.intent.id;
    }

    const missingId = await settleNamed('op-ri04-missing');
    await prisma.requestIntent.update({
      where: { id: missingId },
      data: {
        resultIntegrityDigest: null,
        resultIntegrityProfile: PROTECTED_RESULT_INTEGRITY_PROFILE,
        resultRetention: RESULT_RETENTION.retained,
      },
    });

    const malformedId = await settleNamed('op-ri04-malformed');
    await prisma.requestIntent.update({
      where: { id: malformedId },
      data: { resultIntegrityDigest: 'not-a-digest' },
    });

    const unsupportedId = await settleNamed('op-ri04-unsupported');
    await prisma.requestIntent.update({
      where: { id: unsupportedId },
      data: { resultIntegrityProfile: 'pri/v0-unsupported' },
    });

    const historicalId = await settleNamed('op-ri04-historical');
    await prisma.requestIntent.update({
      where: { id: historicalId },
      data: {
        resultIntegrityProfile: null,
        resultIntegrityDigest: null,
        resultRetention: null,
      },
    });

    const cases: Array<{
      op: string;
      reason: string;
    }> = [
      { op: 'op-ri04-missing', reason: INTEGRITY_REFUSAL_REASON.integrity_digest_missing },
      { op: 'op-ri04-malformed', reason: INTEGRITY_REFUSAL_REASON.integrity_digest_malformed },
      {
        op: 'op-ri04-unsupported',
        reason: INTEGRITY_REFUSAL_REASON.integrity_version_unsupported,
      },
      { op: 'op-ri04-historical', reason: INTEGRITY_REFUSAL_REASON.integrity_unverified },
    ];

    for (const c of cases) {
      const before = await prisma.requestIntent.findUnique({
        where: { apiKeyId_intentKey: { apiKeyId: KEY_A, intentKey: c.op } },
      });
      const replay = await billing.openIntent({
        apiKeyId: KEY_A,
        intentKey: c.op,
        clientSupplied: true,
        payloadFingerprint: `fp-${c.op}`,
        holdUsd: '1.5',
      });
      expect(replay.outcome).toBe('integrity_refused');
      if (replay.outcome === 'integrity_refused') {
        expect(replay.reason).toBe(c.reason);
      }
      const after = await prisma.requestIntent.findUnique({
        where: { apiKeyId_intentKey: { apiKeyId: KEY_A, intentKey: c.op } },
      });
      // No on-read backfill.
      expect(after!.resultIntegrityDigest).toBe(before!.resultIntegrityDigest);
      expect(after!.resultIntegrityProfile).toBe(before!.resultIntegrityProfile);
      expect(after!.resultRetention).toBe(before!.resultRetention);
    }
  });
});

describe('RI05 — equivalences under pri/v1 and real differences', () => {
  it('object order / nesting / Unicode / number vs string / null / PG jsonb round-trip', async () => {
    await fund(KEY_A, '10');
    const body = {
      b: 2,
      a: { z: 'café', y: [1, null, 'x'] },
      n: 3,
      s: '3',
    };
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri05',
      payloadFingerprint: 'fp-ri05',
    });
    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1',
        response: body,
        requestId: 'req-ri05',
      }),
    ).toBe(true);

    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(priV1CanonicalJson(row!.response)).toBe(priV1CanonicalJson(body));
    // Key order difference is equivalent under the profile.
    expect(priV1CanonicalJson({ a: 1, b: 2 })).toBe(priV1CanonicalJson({ b: 2, a: 1 }));
    // Number vs string is a real difference.
    expect(priV1CanonicalJson({ n: 3 })).not.toBe(priV1CanonicalJson({ n: '3' }));

    const replay = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri05',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri05',
      holdUsd: '1.5',
    });
    expect(replay.outcome).toBe('replay');

    // Mutate number→string in stored JSON → digest mismatch.
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: {
        response: {
          b: 2,
          a: { z: 'café', y: [1, null, 'x'] },
          n: '3',
          s: '3',
        } as Prisma.InputJsonValue,
      },
    });
    const refused = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri05',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri05',
      holdUsd: '1.5',
    });
    expect(refused.outcome).toBe('integrity_refused');
    if (refused.outcome === 'integrity_refused') {
      expect(refused.reason).toBe(INTEGRITY_REFUSAL_REASON.integrity_digest_mismatch);
    }
  });
});

describe('RI06 — competing settlements + repeated replay', () => {
  it('only CAS winner persists result, integrity and accounting', async () => {
    await fund(KEY_A, '10');
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri06',
      payloadFingerprint: 'fp-ri06',
    });

    const [w1, w2] = await Promise.all([
      billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1.1',
        response: { winner: 1 },
        requestId: 'req-ri06-1',
      }),
      billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1.2',
        response: { winner: 2 },
        requestId: 'req-ri06-2',
      }),
    ]);
    expect([w1, w2].filter(Boolean)).toHaveLength(1);

    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row!.protectedPhase).toBe(PROTECTED_PHASE.settled);
    expect(row!.resultRetention).toBe(RESULT_RETENTION.retained);
    expect(row!.resultIntegrityDigest).toBeTruthy();
    const winnerDigest = row!.resultIntegrityDigest;
    const winnerBody = priV1CanonicalJson(row!.response);
    expect(
      await prisma.creditsLedger.count({
        where: { apiKeyId: KEY_A, entryType: 'charge' },
      }),
    ).toBe(1);

    // M-RI-LOSER-WRITES: a late CAS loser must not overwrite result/integrity.
    // Use the post-settle generation so the settle path reaches the CAS (and
    // loses on phase), rather than returning early on a stale generation fence.
    expect(
      await billing.settleIntent({
        intent: {
          ...opened.intent,
          generation: row!.generation,
          protectedPhase: PROTECTED_PHASE.settled,
        },
        amountUsd: '9.9',
        response: { winner: 'late-loser' },
        requestId: 'req-ri06-late',
      }),
    ).toBe(false);
    const afterLoser = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(priV1CanonicalJson(afterLoser!.response)).toBe(winnerBody);
    expect(afterLoser!.resultIntegrityDigest).toBe(winnerDigest);

    const classified = classifyProtectedIntentReplay({
      row: row!,
      payloadFingerprint: 'fp-ri06',
    });
    expect(classified.kind).toBe('replay_eligible');

    for (let i = 0; i < 3; i++) {
      const replay = await billing.openIntent({
        apiKeyId: KEY_A,
        intentKey: 'op-ri06',
        clientSupplied: true,
        payloadFingerprint: 'fp-ri06',
        holdUsd: '1.5',
      });
      expect(replay.outcome).toBe('replay');
    }
    expect(
      await prisma.creditsLedger.count({
        where: { apiKeyId: KEY_A, entryType: 'charge' },
      }),
    ).toBe(1);
  });
});

describe('RI07 — injected failure around writes, then reopen', () => {
  it('no half-pair or double charge; unknown stays under original identity', async () => {
    await fund(KEY_A, '10');
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri07',
      payloadFingerprint: 'fp-ri07',
    });

    // Inject failure after the CAS+integrity write but before commit by making
    // chargeInTx throw inside the same settlement transaction — the whole
    // transaction must roll back (no half-pair, no charge).
    const chargeSpy = vi
      .spyOn(
        billing as unknown as { chargeInTx: (...args: unknown[]) => Promise<boolean> },
        'chargeInTx',
      )
      .mockRejectedValueOnce(new Error('injected charge failure'));

    await expect(
      billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1',
        response: { should: 'roll-back' },
        requestId: 'req-ri07-fail',
      }),
    ).rejects.toThrow(/injected charge failure/);
    chargeSpy.mockRestore();

    const mid = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(mid!.protectedPhase).toBe(PROTECTED_PHASE.dispatch_committed);
    expect(mid!.resultIntegrityDigest).toBeNull();
    expect(mid!.resultRetention).toBeNull();
    expect(mid!.response).toBeNull();
    expect(
      await prisma.creditsLedger.count({
        where: { apiKeyId: KEY_A, entryType: 'charge' },
      }),
    ).toBe(0);

    // Mark unknown (uncertain commit status) and reopen via a new connection:
    // identity preserved, no new provider attempt / charge.
    expect(await billing.markProtectedUnknown(opened.intent)).toBe(true);

    const fresh = openFreshClient();
    try {
      const row = await fresh.requestIntent.findUnique({ where: { id: opened.intent.id } });
      expect(row!.protectedPhase).toBe(PROTECTED_PHASE.unknown);
      expect(row!.resultIntegrityDigest).toBeNull();
      expect(row!.intentKey).toBe('op-ri07');
      expect(row!.reservationRef).toBe(opened.reservation.reservationRef);

      const freshBilling = new BillingService(fresh as unknown as PrismaService);
      const reopen = await freshBilling.openIntent({
        apiKeyId: KEY_A,
        intentKey: 'op-ri07',
        clientSupplied: true,
        payloadFingerprint: 'fp-ri07',
        holdUsd: '1.5',
      });
      expect(reopen.outcome).toBe('protected_unknown');
      expect(
        await fresh.creditsLedger.count({
          where: { apiKeyId: KEY_A, entryType: 'charge' },
        }),
      ).toBe(0);

      // Later successful settle from unknown (settleable) is exact-once.
      const settled = await billing.settleIntent({
        intent: {
          ...opened.intent,
          generation: row!.generation,
          protectedPhase: PROTECTED_PHASE.unknown,
        },
        amountUsd: '1',
        response: { recovered: true },
        requestId: 'req-ri07-ok',
      });
      expect(settled).toBe(true);
      expect(
        await prisma.creditsLedger.count({
          where: { apiKeyId: KEY_A, entryType: 'charge' },
        }),
      ).toBe(1);
      const after = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
      expect(after!.resultRetention).toBe(RESULT_RETENTION.retained);
      expect(after!.resultIntegrityDigest).toBeTruthy();
    } finally {
      await fresh.$disconnect();
    }
  });
});

describe('RI08 — absent / oversized / unsupported after synthetic spend', () => {
  it('not replayable; accounting preserved; no truncated body; no zero charge', async () => {
    await fund(KEY_A, '10');
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri08',
      payloadFingerprint: 'fp-ri08',
    });

    const oversized = { blob: 'x'.repeat(MAX_REPLAYABLE_RESPONSE_BYTES) };
    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '2.5',
        response: oversized,
        requestId: 'req-ri08',
      }),
    ).toBe(true);

    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row!.state).toBe('completed');
    expect(row!.protectedPhase).toBe(PROTECTED_PHASE.settled);
    expect(row!.response).toBeNull();
    expect(row!.resultRetention).toBe(RESULT_RETENTION.not_retainable);
    expect(row!.resultIntegrityDigest).toBeNull();
    expect(row!.resultIntegrityProfile).toBeNull();

    const charge = await prisma.creditsLedger.findFirst({
      where: { apiKeyId: KEY_A, entryType: 'charge' },
    });
    expect(charge).not.toBeNull();
    expect(new Prisma.Decimal(charge!.amountUsd).abs().equals(new Prisma.Decimal('2.5'))).toBe(
      true,
    );

    const replay = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri08',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri08',
      holdUsd: '1.5',
    });
    expect(replay.outcome).toBe('not_replayable');
    expect(replay.outcome).not.toBe('replay');
  });
});

describe('RI09 — valid integrity but wrong/revoked recipient', () => {
  it('NOT_MEASURED: no native read entitlement exists', () => {
    // Integrity alone must not invent a live disclosure grant. Native
    // per-recipient / resource entitlement is P5 / P10-01..04 and is not
    // present in this service. Do not fake a fixture-authority pass.
    expect('NOT_MEASURED').toBe('NOT_MEASURED');
  });
});

describe('RI10 — legacy lifecycle-0 and P10-05 refusals stay green', () => {
  it('legacy lifecycle-0 completed replay still works without integrity columns', async () => {
    await fund(KEY_A, '10');
    const opened = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri10-legacy',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri10-legacy',
      holdUsd: '1',
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;
    expect(opened.intent.lifecycleVersion ?? 0).toBe(0);

    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '0.5',
        response: { legacy: true },
        requestId: 'req-ri10',
      }),
    ).toBe(true);

    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row!.lifecycleVersion).toBe(0);
    expect(row!.resultIntegrityDigest).toBeNull();

    const replay = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri10-legacy',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri10-legacy',
      holdUsd: '1',
    });
    expect(replay.outcome).toBe('replay');
  });

  it('P10-05 inconsistent settled completedAt=null stays not_replayable', async () => {
    await fund(KEY_A, '10');
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri10-p1005',
      payloadFingerprint: 'fp-ri10-p1005',
    });
    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1',
        response: { ok: true },
        requestId: 'req-ri10-p1005',
      }),
    ).toBe(true);
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { completedAt: null },
    });

    const replay = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri10-p1005',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri10-p1005',
      holdUsd: '1.5',
    });
    expect(replay.outcome).toBe('not_replayable');
  });
});

describe('mutant assertion anchors (service-level)', () => {
  it('M-RI-NO-COMPARE / M-RI-NO-BINDING / M-RI-NO-VERSION / M-RI-BACKFILL / M-RI-RESNAPSHOT anchors', async () => {
    await fund(KEY_A, '10');
    const body = { anchor: true };
    const opened = await prepareAndCommit({
      apiKeyId: KEY_A,
      operationKey: 'op-ri-mut',
      payloadFingerprint: 'fp-ri-mut',
    });
    expect(
      await billing.settleIntent({
        intent: opened.intent,
        amountUsd: '1',
        response: body,
        requestId: 'req-ri-mut',
      }),
    ).toBe(true);
    const row = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(row!.resultIntegrityDigest).toBe(
      computeProtectedResultIntegrityDigest({
        binding: {
          operationKey: 'op-ri-mut',
          apiKeyId: KEY_A,
          payloadFingerprint: 'fp-ri-mut',
          reservationRef: row!.reservationRef!,
          settlementGeneration: row!.generation,
        },
        retained: body,
      }),
    );

    // M-RI-NO-COMPARE: removing digest comparison would make tampering replay.
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: { response: { anchor: false } as Prisma.InputJsonValue },
    });
    const tampered = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri-mut',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri-mut',
      holdUsd: '1.5',
    });
    expect(tampered.outcome).toBe('integrity_refused');
    expect(tampered.outcome).not.toBe('replay');

    // M-RI-BACKFILL: historical null digest must not become replay by hashing on read.
    await prisma.requestIntent.update({
      where: { id: opened.intent.id },
      data: {
        response: body as Prisma.InputJsonValue,
        resultIntegrityDigest: null,
        resultIntegrityProfile: null,
        resultRetention: null,
      },
    });
    const historical = await billing.openIntent({
      apiKeyId: KEY_A,
      intentKey: 'op-ri-mut',
      clientSupplied: true,
      payloadFingerprint: 'fp-ri-mut',
      holdUsd: '1.5',
    });
    expect(historical.outcome).toBe('integrity_refused');
    if (historical.outcome === 'integrity_refused') {
      expect(historical.reason).toBe(INTEGRITY_REFUSAL_REASON.integrity_unverified);
    }
    const after = await prisma.requestIntent.findUnique({ where: { id: opened.intent.id } });
    expect(after!.resultIntegrityDigest).toBeNull();
  });
});
