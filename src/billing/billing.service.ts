/**
 * ARAS-0064 — charge measured token spend against a client's balance.
 *
 * The connector already MEASURED money (`Request.costUsd`) without ever
 * SPENDING it. This service closes that gap in two steps:
 *
 *   precheck  — before dispatch, refuse when the balance cannot cover an
 *               estimate. Cheap, and it fails BEFORE provider spend, which is
 *               the only point where refusing is free.
 *   settle    — after dispatch, debit the ACTUAL cost. The estimate is never
 *               charged: a caller must never be billed for a number we made up.
 *
 * The ledger is append-only and is the source of truth; `CreditsBalance` is a
 * materialised running total so a precheck is one indexed read rather than a
 * sum over history. If the two ever disagree, rebuild the balance from the
 * ledger, never the reverse.
 *
 * ARAS-0058 replaced the read-only precheck with a HOLD, because a read is not
 * a gate. `precheck()` was a plain `findUnique`: N parallel requests on one
 * balance all read it, all passed, all dispatched and all debited, and `arcana`
 * IS a parallel agent, so that was the normal traffic shape rather than an edge
 * case. The three properties that replaced it:
 *
 *   reserve  — a conditional UPDATE carrying `WHERE balance_usd - held_usd >=
 *              amount`. The database, not application code, decides who wins;
 *              a conditional UPDATE re-evaluates its predicate after taking the
 *              row lock, so the losers see the winner's hold and are refused
 *              BEFORE the provider is called.
 *   settle   — releases the hold and debits the ACTUAL cost in one
 *              transaction, clamped so the balance can never cross the
 *              database's `CHECK (balance_usd >= 0)` floor. The provider has
 *              already been paid, so a charge is ALWAYS recorded in full; the
 *              part a depleted balance cannot cover is written off as an
 *              explicit `uncollectible` entry rather than pushed into a
 *              negative balance nobody queries.
 *   release  — gives the hold back when the dispatch never became a charge.
 *
 * Every one of those is idempotent by state transition (`updateMany` on
 * `state: 'held'` returning a count), not by read-then-write, because a
 * read-then-write races with itself exactly when the system is busiest.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { InsufficientCreditsError } from './billing.errors';
import {
  DEFAULT_HOLD_TTL_MS,
  DEFAULT_INTENT_RETENTION_MS,
  MAX_REPLAYABLE_RESPONSE_BYTES,
  ledgerKeyForIntent,
  writeOffKeyForIntent,
} from './intent';

/**
 * ARAS-0071 — what kind of movement a ledger entry records.
 *
 * A gift and a payment are the same arithmetic and completely different facts.
 * Keeping them apart is an accounting requirement, not a cosmetic one: revenue
 * must never include money nobody paid.
 */
export type LedgerEntryType = 'charge' | 'gift' | 'credit' | 'uncollectible';

/** A live reservation, and the handle every later step is keyed on. */
export interface RequestIntentHandle {
  id: string;
  apiKeyId: string;
  intentKey: string;
  holdUsd: Prisma.Decimal;
}

/**
 * What {@link BillingService.openIntent} decided.
 *
 * A discriminated result rather than exceptions for the expected answers: "you
 * are out of money" and "you already asked me this" are normal replies to a
 * request, and modelling them as faults is how they end up surfacing to an
 * agent as an indistinguishable 500.
 */
export type IntentOpenResult =
  /** Reserved; go ahead and dispatch. */
  | { outcome: 'opened'; intent: RequestIntentHandle }
  /** This exact intent already completed — return `response`, call nothing. */
  | { outcome: 'replay'; response: unknown; requestId?: string }
  /** Known key, still running. Not a replay yet. */
  | { outcome: 'in_flight' }
  /** Known key, different payload. A caller bug, reported rather than hidden. */
  | { outcome: 'payload_mismatch' }
  /** Completed, but the response was too large to store. */
  | { outcome: 'not_replayable' }
  /** The reservation lost the race, or the account is empty. */
  | { outcome: 'insufficient'; balanceUsd: string; requiredUsd: string };

/**
 * Internal signal that the conditional reservation matched no row.
 *
 * Thrown to unwind the transaction — an intent that could not reserve must not
 * survive, or its key would be burned by a request that never ran. Never
 * escapes the service.
 */
class HoldRejected extends Error {
  constructor() {
    super('hold rejected: available balance does not cover the reservation');
    this.name = 'HoldRejected';
  }
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Current balance; an account with no ledger history reads as zero. */
  async balance(apiKeyId: string): Promise<Prisma.Decimal> {
    const row = await this.prisma.creditsBalance.findUnique({ where: { apiKeyId } });
    return row?.balanceUsd ?? new Prisma.Decimal(0);
  }

  /**
   * ARAS-0058 — what the account can actually spend right now: the balance
   * minus everything reserved by requests already in flight.
   *
   * This, not `balance()`, is the number a spend decision is made against.
   * `balance()` still answers "how much money is in the account", which is what
   * a customer-facing statement should show — money held for a request in
   * flight has not left the account yet.
   */
  async available(apiKeyId: string): Promise<Prisma.Decimal> {
    const row = await this.prisma.creditsBalance.findUnique({ where: { apiKeyId } });
    if (!row) return new Prisma.Decimal(0);
    return row.balanceUsd.minus(row.heldUsd);
  }

  /**
   * Report whether the account can afford `estimateUsd` right now.
   *
   * ADVISORY ONLY — this is a read, and a read is not a gate. Between the
   * answer and any action taken on it, another request can take the money;
   * that race is precisely what ARAS-0058 found in production. Anything that
   * gates SPEND must call {@link openIntent}, which reserves atomically.
   * This remains for reporting and for callers that only want to warn.
   *
   * @throws InsufficientCreditsError
   */
  async precheck(apiKeyId: string, estimateUsd: Prisma.Decimal | number | string): Promise<void> {
    const required = new Prisma.Decimal(estimateUsd);
    const current = await this.available(apiKeyId);
    if (current.lessThan(required)) {
      throw new InsufficientCreditsError(apiKeyId, current.toString(), required.toString());
    }
  }

  /**
   * Debit the actual cost of a completed request.
   *
   * `idempotencyKey` is what makes a retry safe. The uniqueness is enforced by
   * the DATABASE, not by a read-then-write in application code, because a
   * check-then-insert races with itself under concurrency and would
   * double-charge exactly when the system is busiest.
   *
   * Returns true when this call performed the debit, false when the key had
   * already been settled — so a caller can tell "charged" from "already
   * charged" without inspecting the ledger.
   */
  async settle(params: {
    apiKeyId: string;
    amountUsd: Prisma.Decimal | number | string;
    idempotencyKey: string;
    requestId?: string;
    reason?: string;
  }): Promise<boolean> {
    const amount = new Prisma.Decimal(params.amountUsd);
    if (amount.isNegative()) {
      throw new Error('settle() charges a cost; a negative amount would credit the account');
    }
    try {
      return await this.prisma.$transaction((tx) => this.settleInTx(tx, params));
    } catch (err) {
      if (BillingService.isDuplicateKey(err)) {
        this.logger.log('billing: idempotency key already settled, not charging again (request)');
        return false;
      }
      throw err;
    }
  }

  /**
   * {@link settle} inside a transaction the CALLER owns.
   *
   * ARAS-0058 — the dispatch path now writes the `Request` row and the ledger
   * row in one transaction, so it needs to hand its own `tx` in; opening a
   * nested `$transaction` would take a second connection and deadlock against
   * the balance-row lock the outer one already holds.
   *
   * A duplicate key here aborts the caller's transaction rather than returning
   * false — inside a transaction there is no partial recovery, and on this path
   * the key is freshly minted, so a collision is a real invariant violation and
   * should be loud. Callers that can legitimately race a duplicate (the
   * reconciler) use {@link settle}, which owns its transaction and can absorb
   * the rejection.
   */
  async settleInTx(
    tx: Prisma.TransactionClient,
    params: {
      apiKeyId: string;
      amountUsd: Prisma.Decimal | number | string;
      idempotencyKey: string;
      requestId?: string;
      reason?: string;
    },
  ): Promise<boolean> {
    const amount = new Prisma.Decimal(params.amountUsd);
    if (amount.isNegative()) {
      throw new Error('settle() charges a cost; a negative amount would credit the account');
    }
    return this.chargeInTx(tx, {
      apiKeyId: params.apiKeyId,
      amountUsd: amount,
      idempotencyKey: params.idempotencyKey,
      writeOffKey: `uncollectible:${params.idempotencyKey}`,
      requestId: params.requestId,
      reason: params.reason ?? 'request',
    });
  }

  /**
   * ARAS-0058 — the one place a charge is written, shared by {@link settle},
   * {@link settleIntent} and the reconciler so the clamping rule cannot drift
   * between them.
   *
   * The clamp is the load-bearing part. `credits_balance` now carries
   * `CHECK (balance_usd >= 0)`, and the provider has ALREADY been paid by the
   * time we get here, so a charge that exceeds the balance must not be allowed
   * to fail — losing it would mean the money left the business with no record
   * at all. The charge is therefore always recorded in full, and the part the
   * balance cannot cover is posted back as an explicit `uncollectible` entry.
   *
   * That keeps two invariants true at once, which was the whole difficulty:
   *   `balance_usd = SUM(amount_usd)`  and  `balance_usd >= 0`.
   *
   * And it turns revenue lost to estimate overshoot into a single queryable
   * SUM over `entry_type = 'uncollectible'`, instead of an inference from a
   * negative balance nobody has a dashboard for.
   */
  private async chargeInTx(
    tx: Prisma.TransactionClient,
    entry: {
      apiKeyId: string;
      amountUsd: Prisma.Decimal;
      idempotencyKey: string;
      writeOffKey: string;
      requestId?: string;
      reason: string;
    },
  ): Promise<boolean> {
    // The ledger row goes in FIRST: its unique index is the anti-double-charge
    // invariant, so it must be the thing that rejects a replay, before any
    // balance has moved. A zero-cost request still gets a row — the absence of
    // a charge is itself worth recording, and it keeps the key reserved.
    await tx.creditsLedger.create({
      data: {
        apiKeyId: entry.apiKeyId,
        amountUsd: entry.amountUsd.negated(),
        idempotencyKey: entry.idempotencyKey,
        requestId: entry.requestId,
        reason: entry.reason,
        entryType: 'charge',
      },
    });

    // Take the row lock before reading, so the collectible/uncollectible split
    // is computed against a balance no concurrent settle can move underneath
    // us. `FOR UPDATE` rather than a conditional UPDATE here because we need
    // the VALUE, not just a yes/no.
    await tx.creditsBalance.upsert({
      where: { apiKeyId: entry.apiKeyId },
      create: { apiKeyId: entry.apiKeyId, balanceUsd: 0, heldUsd: 0 },
      update: {},
    });
    const locked = await tx.$queryRaw<{ balance_usd: Prisma.Decimal }[]>`
      SELECT balance_usd FROM credits_balance WHERE api_key_id = ${entry.apiKeyId} FOR UPDATE
    `;
    const current = new Prisma.Decimal(locked[0]?.balance_usd ?? 0);
    const collectible = entry.amountUsd.greaterThan(current) ? current : entry.amountUsd;
    const uncollectible = entry.amountUsd.minus(collectible);

    if (uncollectible.greaterThan(0)) {
      await tx.creditsLedger.create({
        data: {
          apiKeyId: entry.apiKeyId,
          amountUsd: uncollectible,
          idempotencyKey: entry.writeOffKey,
          requestId: entry.requestId,
          reason: `uncollectible:${entry.reason}`,
          entryType: 'uncollectible',
        },
      });
      this.logger.warn(
        `ARAS-0058 billing: charged ${entry.amountUsd.toString()} USD against a ` +
          `${current.toString()} USD balance for api key ${entry.apiKeyId}; ` +
          `${uncollectible.toString()} USD written off as uncollectible ` +
          `(key=${entry.idempotencyKey})`,
      );
    }

    if (collectible.greaterThan(0)) {
      await tx.creditsBalance.update({
        where: { apiKeyId: entry.apiKeyId },
        data: { balanceUsd: { decrement: collectible } },
      });
    }
    return true;
  }

  /** Add credit — the operator's virtual top-up path. */
  async credit(params: {
    apiKeyId: string;
    amountUsd: Prisma.Decimal | number | string;
    idempotencyKey: string;
    reason?: string;
    entryType?: LedgerEntryType;
  }): Promise<boolean> {
    const amount = new Prisma.Decimal(params.amountUsd);
    if (!amount.greaterThan(0)) {
      throw new Error('credit() adds funds; use settle() to charge');
    }
    return this.post({
      apiKeyId: params.apiKeyId,
      amountUsd: amount,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason ?? 'manual-credit',
      entryType: params.entryType ?? 'credit',
    });
  }

  /**
   * ARAS-0071 — grant credit the recipient did not pay for.
   *
   * Separate from `credit()` so the gift path cannot be reached by accident and
   * so its extra rules live in one place:
   *   - the amount must be strictly positive; zero is a no-op that would still
   *     burn an idempotency key, and a negative would be a debit wearing a
   *     gift's label
   *   - a reason is REQUIRED. A gift is money appearing from nowhere; an
   *     auditor asking "why does this account have $50" must find the answer
   *     in the ledger, not in someone's memory.
   *
   * Gifts can only ADD. There is deliberately no gift-shaped debit: taking
   * money back is a charge, and it should look like one in the history.
   */
  async gift(params: {
    apiKeyId: string;
    amountUsd: Prisma.Decimal | number | string;
    idempotencyKey: string;
    reason: string;
  }): Promise<boolean> {
    const amount = new Prisma.Decimal(params.amountUsd);
    if (!amount.isFinite()) {
      throw new Error('gift() requires a finite amount');
    }
    if (!amount.greaterThan(0)) {
      throw new Error('gift() only adds credit; the amount must be greater than zero');
    }
    const reason = params.reason?.trim();
    if (!reason) {
      throw new Error('gift() requires a reason — a gift must be auditable');
    }
    return this.post({
      apiKeyId: params.apiKeyId,
      amountUsd: amount,
      idempotencyKey: params.idempotencyKey,
      reason,
      entryType: 'gift',
    });
  }

  /** Ledger history, newest first. */
  async history(apiKeyId: string, limit = 50) {
    return this.prisma.creditsLedger.findMany({
      where: { apiKeyId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // ARAS-0058 — request intents: the hold, and per-intent idempotency.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Open an intent: claim the idempotency key and RESERVE the estimate.
   *
   * The reservation is a conditional UPDATE carrying
   * `WHERE balance_usd - held_usd >= amount`. That predicate is re-evaluated
   * by Postgres AFTER the row lock is taken, so of N concurrent callers racing
   * a one-request balance exactly one sees a sufficient available balance and
   * the rest are refused — before any of them reaches a provider, which is the
   * only point at which refusing is free. No application-level check can do
   * this; the previous `findUnique` precheck let all N through.
   *
   * Returns a discriminated outcome rather than throwing for the expected
   * answers, because "you are out of money" and "you already asked me this"
   * are normal replies to a request, not faults.
   */
  async openIntent(params: {
    apiKeyId: string;
    intentKey: string;
    clientSupplied: boolean;
    payloadFingerprint: string;
    holdUsd: Prisma.Decimal | number | string;
    ttlMs?: number;
  }): Promise<IntentOpenResult> {
    const hold = new Prisma.Decimal(params.holdUsd);
    if (hold.isNegative()) {
      throw new Error('openIntent() reserves funds; a negative hold would release them');
    }
    const expiresAt = new Date(Date.now() + (params.ttlMs ?? DEFAULT_HOLD_TTL_MS));

    try {
      const intent = await this.prisma.$transaction(async (tx) => {
        const created = await tx.requestIntent.create({
          data: {
            apiKeyId: params.apiKeyId,
            intentKey: params.intentKey,
            clientSupplied: params.clientSupplied,
            payloadFingerprint: params.payloadFingerprint,
            holdUsd: hold,
            state: 'held',
            expiresAt,
          },
        });

        await BillingService.reserveInTx(tx, params.apiKeyId, hold);
        return created;
      });

      return {
        outcome: 'opened',
        intent: {
          id: intent.id,
          apiKeyId: intent.apiKeyId,
          intentKey: intent.intentKey,
          holdUsd: new Prisma.Decimal(intent.holdUsd),
        },
      };
    } catch (err) {
      if (err instanceof HoldRejected) {
        // Read the numbers only now, for the message. Reading them as part of
        // the decision would have re-introduced the very race this replaced.
        const current = await this.available(params.apiKeyId);
        return {
          outcome: 'insufficient',
          balanceUsd: current.toString(),
          requiredUsd: hold.toString(),
        };
      }
      if (BillingService.isDuplicateKey(err)) {
        return this.resolveReplay({
          apiKeyId: params.apiKeyId,
          intentKey: params.intentKey,
          payloadFingerprint: params.payloadFingerprint,
          holdUsd: hold,
          expiresAt,
        });
      }
      throw err;
    }
  }

  /**
   * What a repeat of an already-claimed intent key should get.
   *
   * Four honest answers, and deliberately no fifth that guesses:
   *   - a different payload under the same key is a CALLER BUG, and answering
   *     it with the first payload's response would hide the bug behind a
   *     correct-looking reply;
   *   - a completed intent replays its stored response — one provider call,
   *     one ledger row, however many times the client re-POSTs;
   *   - a completed intent whose response was too large to store cannot be
   *     replayed, and says so rather than returning a different body;
   *   - an intent still in flight is not a replay yet. Returning the first
   *     request's eventual answer would require waiting on it; reporting the
   *     conflict lets the caller decide.
   */
  private async resolveReplay(params: {
    apiKeyId: string;
    intentKey: string;
    payloadFingerprint: string;
    holdUsd: Prisma.Decimal;
    expiresAt: Date;
  }): Promise<IntentOpenResult> {
    const { apiKeyId, intentKey, payloadFingerprint } = params;
    const existing = await this.prisma.requestIntent.findUnique({
      where: { apiKeyId_intentKey: { apiKeyId, intentKey } },
    });
    if (!existing) {
      // The row vanished between the failed insert and this read — a purge, or
      // a concurrent delete. Treat it as in-flight: the caller retries and gets
      // a clean open.
      return { outcome: 'in_flight' };
    }
    if (existing.payloadFingerprint !== payloadFingerprint) {
      // Checked BEFORE the state, deliberately. Reusing a key for a different
      // request is a caller bug whether or not the first attempt succeeded.
      return { outcome: 'payload_mismatch' };
    }
    if (existing.state === 'completed') {
      return existing.response == null
        ? { outcome: 'not_replayable' }
        : {
            outcome: 'replay',
            response: existing.response,
            requestId: existing.requestId ?? undefined,
          };
    }
    if (existing.state === 'held') {
      return { outcome: 'in_flight' };
    }
    // 'released' or 'expired': the first attempt under this key did NOT
    // complete and was NOT charged. Refusing the retry would be the worst of
    // both worlds — the caller is blocked for the whole retention window
    // BECAUSE they asked for idempotency, and the request they wanted was never
    // performed. Reclaim the key and let them through.
    return this.reclaimIntent(existing.id, params);
  }

  /**
   * Take an abandoned intent key back and re-reserve against it.
   *
   * The `updateMany` guarded on the abandoned states is the race control: two
   * callers retrying the same failed key both attempt it and exactly one moves
   * the row, so the other correctly sees an in-flight request rather than
   * opening a second dispatch.
   */
  private async reclaimIntent(
    intentId: string,
    params: {
      apiKeyId: string;
      intentKey: string;
      payloadFingerprint: string;
      holdUsd: Prisma.Decimal;
      expiresAt: Date;
    },
  ): Promise<IntentOpenResult> {
    try {
      const reclaimed = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.requestIntent.updateMany({
          where: { id: intentId, state: { in: ['released', 'expired'] } },
          data: {
            state: 'held',
            holdUsd: params.holdUsd,
            expiresAt: params.expiresAt,
            // Cleared, not kept: this is a fresh attempt, and leaving the
            // previous one's request id attached would misattribute it.
            requestId: null,
            response: Prisma.DbNull,
            completedAt: null,
          },
        });
        if (claimed.count !== 1) return null;
        await BillingService.reserveInTx(tx, params.apiKeyId, params.holdUsd);
        return true;
      });
      if (!reclaimed) return { outcome: 'in_flight' };
      return {
        outcome: 'opened',
        intent: {
          id: intentId,
          apiKeyId: params.apiKeyId,
          intentKey: params.intentKey,
          holdUsd: params.holdUsd,
        },
      };
    } catch (err) {
      if (err instanceof HoldRejected) {
        const current = await this.available(params.apiKeyId);
        return {
          outcome: 'insufficient',
          balanceUsd: current.toString(),
          requiredUsd: params.holdUsd.toString(),
        };
      }
      throw err;
    }
  }

  /**
   * Settle an intent: release its hold and debit the ACTUAL cost, atomically.
   *
   * One transaction, so the hold cannot be released without the charge landing
   * and the charge cannot land twice. `updateMany` on `state: 'held'` is the
   * concurrency control: whoever moves the state is the one that charges, and
   * a second caller gets a count of zero and does nothing.
   *
   * Returns false when the intent was already settled or released, so the
   * caller can tell "charged" from "already charged" without reading back.
   */
  async settleIntent(params: {
    intent: RequestIntentHandle;
    amountUsd: Prisma.Decimal | number | string;
    requestId?: string;
    response?: unknown;
    reason?: string;
  }): Promise<boolean> {
    const amount = new Prisma.Decimal(params.amountUsd);
    if (amount.isNegative()) {
      throw new Error('settleIntent() charges a cost; a negative amount would credit the account');
    }
    try {
      return await this.prisma.$transaction((tx) => this.settleIntentInTx(tx, params));
    } catch (err) {
      if (BillingService.isDuplicateKey(err)) {
        this.logger.log(
          `billing: intent ${params.intent.id} was already settled, not charging again`,
        );
        return false;
      }
      throw err;
    }
  }

  /**
   * {@link settleIntent} inside a transaction the CALLER owns — so the
   * `Request` row and the charge that settles it commit together or not at all.
   *
   * That atomicity is the ARAS-0058 durability fix. Settlement used to happen
   * inside a fire-and-forget `logRequest(...).catch(...)`, so the response
   * reached the customer before either row existed and a SIGTERM in that window
   * meant the provider was paid and the customer was not.
   */
  async settleIntentInTx(
    tx: Prisma.TransactionClient,
    params: {
      intent: RequestIntentHandle;
      amountUsd: Prisma.Decimal | number | string;
      requestId?: string;
      response?: unknown;
      reason?: string;
    },
  ): Promise<boolean> {
    const amount = new Prisma.Decimal(params.amountUsd);
    if (amount.isNegative()) {
      throw new Error('settleIntent() charges a cost; a negative amount would credit the account');
    }
    const response = BillingService.storableResponse(params.response);

    // The state transition IS the concurrency control: whoever moves the intent
    // off `held` is the one that charges, and a second caller gets a count of
    // zero and does nothing. A read-then-write here would race with itself.
    const claimed = await tx.requestIntent.updateMany({
      where: { id: params.intent.id, state: 'held' },
      data: {
        state: 'completed',
        requestId: params.requestId,
        response: response === undefined ? undefined : (response as Prisma.InputJsonValue),
        completedAt: new Date(),
      },
    });
    if (claimed.count !== 1) return false;

    await BillingService.releaseHoldInTx(tx, params.intent);

    return this.chargeInTx(tx, {
      apiKeyId: params.intent.apiKeyId,
      amountUsd: amount,
      idempotencyKey: ledgerKeyForIntent(params.intent.id),
      writeOffKey: writeOffKeyForIntent(params.intent.id),
      requestId: params.requestId,
      reason: params.reason ?? 'model-request',
    });
  }

  /**
   * Give the hold back without charging.
   *
   * Used when the dispatch never became spend — the connector refused before
   * calling out, the process is unwinding after a throw, or the sweeper found
   * an intent whose owner never came back. Releasing is always safe to repeat:
   * only the caller that moves the state off `held` touches the money.
   */
  async releaseIntent(
    intent: RequestIntentHandle,
    state: 'released' | 'expired' = 'released',
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.requestIntent.updateMany({
        where: { id: intent.id, state: 'held' },
        data: { state, completedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await BillingService.releaseHoldInTx(tx, intent);
      return true;
    });
  }

  /**
   * Return reserved funds to the account.
   *
   * `GREATEST(..., 0)` rather than a guarded update because a release must
   * NEVER fail: refusing to give money back on the grounds that the books look
   * odd is the worst possible response. The floor also means this can never
   * trip `CHECK (held_usd >= 0)`. If the subtraction would have gone negative
   * the accounting was already wrong upstream, and the sweeper's log is where
   * that shows up.
   */
  /**
   * Move `hold` from spendable to reserved, or refuse.
   *
   * The conditional UPDATE is the entire concurrency control. Postgres
   * re-evaluates `WHERE balance_usd - held_usd >= amount` AFTER taking the row
   * lock, so of N callers racing the same balance exactly one sees enough and
   * the rest match no row. Nothing in application code can reproduce that: a
   * read-then-write has a window, and this does not.
   *
   * Throws {@link HoldRejected} so the caller's transaction unwinds — an intent
   * that could not reserve must not survive, or its key would be burned by a
   * request that never ran.
   */
  private static async reserveInTx(
    tx: Prisma.TransactionClient,
    apiKeyId: string,
    hold: Prisma.Decimal,
  ): Promise<void> {
    // A zero hold needs no reservation, and demanding one would refuse a
    // catalogued FREE model on a never-credited account — nonsense, and a
    // regression against the behaviour ARAS-0064 deliberately shipped.
    if (!hold.greaterThan(0)) return;
    const moved = await tx.$executeRaw`
      UPDATE credits_balance
         SET held_usd = held_usd + ${hold.toFixed(6)}::numeric,
             updated_at = now()
       WHERE api_key_id = ${apiKeyId}
         AND balance_usd - held_usd >= ${hold.toFixed(6)}::numeric
    `;
    if (moved !== 1) throw new HoldRejected();
  }

  private static async releaseHoldInTx(
    tx: Prisma.TransactionClient,
    intent: RequestIntentHandle,
  ): Promise<void> {
    const hold = new Prisma.Decimal(intent.holdUsd);
    if (!hold.greaterThan(0)) return;
    await tx.$executeRaw`
      UPDATE credits_balance
         SET held_usd = GREATEST(held_usd - ${hold.toFixed(6)}::numeric, 0),
             updated_at = now()
       WHERE api_key_id = ${intent.apiKeyId}
    `;
  }

  /**
   * Release holds whose owner never came back.
   *
   * A hold is a claim on a customer's money. A process SIGKILLed between
   * reserving and settling would otherwise freeze those funds forever, and the
   * customer's only symptom would be a balance that says one thing and a
   * spendable balance that says another. Bounded per sweep so one pathological
   * backlog cannot turn a maintenance tick into a long transaction.
   */
  async sweepExpiredIntents(limit = 500): Promise<{ swept: number; releasedUsd: string }> {
    const stale = await this.prisma.requestIntent.findMany({
      where: { state: 'held', expiresAt: { lt: new Date() } },
      orderBy: { expiresAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 5_000),
    });

    let swept = 0;
    let released = new Prisma.Decimal(0);
    for (const intent of stale) {
      const handle: RequestIntentHandle = {
        id: intent.id,
        apiKeyId: intent.apiKeyId,
        intentKey: intent.intentKey,
        holdUsd: new Prisma.Decimal(intent.holdUsd),
      };
      if (await this.releaseIntent(handle, 'expired')) {
        swept += 1;
        released = released.plus(handle.holdUsd);
        this.logger.warn(
          `ARAS-0058 billing: expired an abandoned hold of ${handle.holdUsd.toString()} USD ` +
            `for api key ${intent.apiKeyId} (intent ${intent.id}, opened ${intent.createdAt.toISOString()})`,
        );
      }
    }
    return { swept, releasedUsd: released.toString() };
  }

  /**
   * Forget completed intents past their replay window.
   *
   * Idempotency is a promise with an expiry date. Without one this table grows
   * without bound, and a key a caller happens to reuse a year later silently
   * returns last year's answer.
   */
  async purgeSettledIntents(retentionMs = DEFAULT_INTENT_RETENTION_MS): Promise<number> {
    const cutoff = new Date(Date.now() - retentionMs);
    const { count } = await this.prisma.requestIntent.deleteMany({
      where: { state: { in: ['completed', 'released', 'expired'] }, createdAt: { lt: cutoff } },
    });
    return count;
  }

  /**
   * Serialise a response for replay, or refuse to.
   *
   * Past the cap the intent completes with no stored response and a later
   * replay is refused. Storing a truncated body would be worse than storing
   * none: the caller asked for "the same answer as last time" and would get a
   * different one without being told.
   */
  private static storableResponse(response: unknown): unknown {
    if (response === undefined) return undefined;
    const serialised = JSON.stringify(response);
    if (serialised === undefined) return undefined;
    if (Buffer.byteLength(serialised, 'utf8') > MAX_REPLAYABLE_RESPONSE_BYTES) return null;
    return JSON.parse(serialised);
  }

  /** A unique-constraint rejection — the database refusing a double-charge. */
  private static isDuplicateKey(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }

  /**
   * Append one signed ledger entry and move the balance by the same amount,
   * in a single transaction so the two can never diverge by a crash between
   * them.
   *
   * ARAS-0058: this is now the CREDIT path only — `credit()` and `gift()`.
   * Charges go through {@link chargeInTx}, which has to clamp against the
   * database's non-negative floor; a credit only ever moves the balance up and
   * needs no clamp.
   */
  private async post(entry: {
    apiKeyId: string;
    amountUsd: Prisma.Decimal;
    idempotencyKey: string;
    requestId?: string;
    reason: string;
    entryType: LedgerEntryType;
  }): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.creditsLedger.create({
          data: {
            apiKeyId: entry.apiKeyId,
            amountUsd: entry.amountUsd,
            idempotencyKey: entry.idempotencyKey,
            requestId: entry.requestId,
            reason: entry.reason,
            entryType: entry.entryType,
          },
        });
        await tx.creditsBalance.upsert({
          where: { apiKeyId: entry.apiKeyId },
          create: { apiKeyId: entry.apiKeyId, balanceUsd: entry.amountUsd },
          update: { balanceUsd: { increment: entry.amountUsd } },
        });
      });
      return true;
    } catch (err) {
      // A unique-constraint rejection is the database refusing a double-post.
      if (BillingService.isDuplicateKey(err)) {
        this.logger.log(
          `billing: idempotency key already settled, not charging again (${entry.reason})`,
        );
        return false;
      }
      throw err;
    }
  }
}
