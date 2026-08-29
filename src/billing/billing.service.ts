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
import { InsufficientCreditsError, ReversalRefusedError } from './billing.errors';
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
export type LedgerEntryType =
  | 'charge'
  | 'gift'
  | 'credit'
  | 'uncollectible'
  | 'payment'
  | 'refund'
  | 'chargeback';

/**
 * BILL-0008 — the two ways a credit can be taken back.
 *
 * Same arithmetic, different facts, so they are different types for the same
 * reason 'gift' and 'payment' are: a refund is a decision we made, a chargeback
 * is one the provider made for us, and an accounting history that cannot tell
 * them apart cannot answer "how much money did we choose to return" — which is
 * a customer-service number — separately from "how much was taken from us",
 * which is a fraud number.
 */
export type ReversalEntryType = Extract<LedgerEntryType, 'refund' | 'chargeback'>;

/**
 * BILL-0008 — the ceiling on any single credit posted through this service.
 *
 * Consilium §6.3 found `CreditSchema` accepting `Infinity`; the finite refine
 * closes that, but "finite" is not a bound and there is no un-post. This is the
 * bound.
 *
 * The value is not arbitrary. `credits_balance.balance_usd` is DECIMAL(12,6) —
 * six integer digits — so the LEDGER PHYSICALLY CANNOT REPRESENT a balance at
 * or above $1,000,000: a credit that crossed it would not be caught by a guard,
 * it would abort the transaction with a numeric overflow from Postgres, at the
 * moment money had already been received. $100,000 sits an order of magnitude
 * under the column's own limit so that a legitimate large top-up plus an
 * existing balance still fits, and is absurd enough as a single movement that
 * anything above it is a typo or an attack either way.
 *
 * Raising it means widening the column first, in that order.
 */
export const MAX_CREDIT_USD = 100_000;

/**
 * BILL-0008 — the audit record of how a USD payment amount came to exist.
 *
 * Every field is INERT. `amountUsd` is the ledger number and the only one any
 * money query may read; these are kept because "the customer paid 0.0031 BTC
 * and we called it $180" is a claim we must be able to reproduce later and
 * cannot reconstruct — the rate at receipt is gone the instant it passes.
 *
 * Consilium §2 forbids a coin ticker or an exchange rate from crossing the
 * provider boundary, and §4.2 requires the valuation at receipt to be recorded
 * before the first payment. Those pull in opposite directions and the
 * resolution is the direction of dependence, not the presence of the fields:
 * §2's prohibition is on a crypto amount DECIDING the credit, and nothing here
 * can. `recordPayment()` never reads this object to compute anything —
 * `amountUsd` arrives already decided by the payments module — so the coin
 * never reaches a money decision even though it reaches the audit log.
 */
export interface PaymentValuation {
  /** Amount in the asset actually sent. */
  assetAmount?: Prisma.Decimal | number | string;
  /** Ticker of the asset actually sent. */
  asset?: string;
  /** USD per unit of `asset` at receipt, as the GATEWAY reported it. */
  usdRateAtReceipt?: Prisma.Decimal | number | string;
  /** When the valuation was taken — not when we got round to posting it. */
  valuedAt?: Date;
}

/**
 * What {@link BillingService.reverse} did.
 *
 * `recoveredUsd` and `writtenOffUsd` are reported separately because they are
 * different outcomes wearing the same number: the first is money actually taken
 * back off the balance, the second is money the customer had already spent and
 * we could not. A caller that only checks `applied` cannot tell a clean refund
 * from a total loss.
 */
export interface ReversalResult {
  applied: boolean;
  reversedUsd: string;
  recoveredUsd: string;
  writtenOffUsd: string;
}

/**
 * BILL-0008 — the provenance columns, as one object so `post()` threads them
 * without growing eight parameters that every non-payment caller passes as
 * undefined.
 */
type LedgerProvenance = {
  source?: string | null;
  externalRef?: string | null;
  livemode?: boolean | null;
  actor?: string | null;
  assetAmount?: Prisma.Decimal | null;
  asset?: string | null;
  usdRateAtReceipt?: Prisma.Decimal | null;
  valuedAt?: Date | null;
};

/**
 * What `reverse()` will act on.
 *
 * Only a CREDIT can be reversed. Reversing a 'charge' is not a reversal, it is
 * a credit, and it must look like one in the history — otherwise the sum over
 * refunds stops meaning "money returned to customers". 'uncollectible' is
 * excluded for the same reason plus a sharper one: it is itself the residue of
 * a movement that could not complete, and reversing it would compound a
 * write-off into a second write-off.
 */
const REVERSIBLE_ENTRY_TYPES: ReadonlySet<string> = new Set(['payment', 'gift', 'credit']);

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

  // ──────────────────────────────────────────────────────────────────────
  // BILL-0008 — money a customer actually sent, and taking it back.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Record a PAYMENT: money a customer actually sent, credited from a verified
   * gateway event.
   *
   * This is the MC half of the contract in consilium §2. The payments module in
   * control-bff owns the invoice, the webhook, the signature check and every
   * question about what a partial payment means; it calls this with an amount
   * already decided. The four scalars that matter — `apiKeyId`, `amountUsd`,
   * `idempotencyKey`, `source` — are the enforcement of that boundary, not a
   * description of it: a coin ticker, a wallet address, a confirmation count or
   * a provider status string cannot physically pass through a signature that
   * has nowhere to put them.
   *
   * What this method deliberately does NOT know:
   *
   *   - what an under-payment is. It credits what it is told. Under, over and
   *     late are policy, they live in control-bff (consilium §3), and a ledger
   *     that had an opinion about them would be a second place for that policy
   *     to be wrong.
   *   - what the money was worth in anything but dollars. `valuation` is stored
   *     and never read.
   *
   * Idempotency rides the existing `credits_ledger.idempotencyKey @unique` and
   * the `P2002` catch in `post()` — the same mechanism as every other credit,
   * namespaced by the caller (`oxapay:payment:<track_id>`). Consilium §9.3:
   * reuse, do not add a second mechanism. `false` means the key was already
   * used and NOTHING happened; a replayed webhook is a no-op, not a second
   * credit.
   */
  async recordPayment(params: {
    apiKeyId: string;
    amountUsd: Prisma.Decimal | number | string;
    idempotencyKey: string;
    /** The provider that took the money — 'oxapay', later 'paypal'/'stripe'. */
    source: string;
    /** Real money or sandbox money. Required: see consilium §5's sandbox trap. */
    livemode: boolean;
    /** The gateway's own immutable reference. */
    externalRef?: string;
    /** Who posted this. 'the ADMIN_TOKEN' is not an actor — consilium §4.6. */
    actor?: string;
    reason?: string;
    /** Inert audit record; never read to compute anything. */
    valuation?: PaymentValuation;
  }): Promise<boolean> {
    const amount = new Prisma.Decimal(params.amountUsd);
    // Finite first. `new Prisma.Decimal(Infinity)` is a perfectly good Decimal
    // and compares greater than everything, so a positivity check alone passes
    // it straight through to a column that cannot hold it (consilium §6.3).
    if (!amount.isFinite()) {
      throw new Error('recordPayment() requires a finite amount');
    }
    if (!amount.greaterThan(0)) {
      throw new Error(
        'recordPayment() records money received; the amount must be greater than zero',
      );
    }
    if (amount.greaterThan(MAX_CREDIT_USD)) {
      throw new Error(
        `recordPayment() refuses ${amount.toString()} USD: above the ${MAX_CREDIT_USD} USD ` +
          'per-credit ceiling. There is no un-post, so the ceiling is checked before the row.',
      );
    }
    const source = params.source?.trim();
    if (!source) {
      throw new Error(
        'recordPayment() requires a source — a payment with no provider is not auditable',
      );
    }

    return this.post({
      apiKeyId: params.apiKeyId,
      amountUsd: amount,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason?.trim() || `payment:${source}`,
      entryType: 'payment',
      provenance: {
        source,
        externalRef: params.externalRef ?? null,
        livemode: params.livemode,
        actor: params.actor ?? null,
        ...BillingService.valuationColumns(params.valuation),
      },
    });
  }

  /**
   * BILL-0008 — post a NEGATIVE entry reversing an earlier credit.
   *
   * This is the hard gate crypto created (consilium §4.1). Before it, `gift()`
   * and `credit()` rejected non-positive amounts and `settle()` rejected
   * negative ones, so an irreversible bad credit could not be undone in the
   * ledger AT ALL — the only available fix was to hand-write a row outside
   * every invariant this service exists to hold. With cards the issuer could
   * reverse for us; with crypto nothing does, so the primitive has to exist
   * before the first live key even though no adapter reaches it yet.
   *
   * Four refusals, all of them the same principle — a reversal must be
   * explainable by the ledger alone:
   *
   *   - the original must exist. Reversing a key we never posted would create a
   *     negative entry with nothing behind it.
   *   - the original must be a CREDIT. Reversing a charge is not a reversal, it
   *     is a credit, and it should look like one in the history.
   *   - the total reversed must never exceed the original. Otherwise a repeated
   *     partial refund quietly becomes a withdrawal.
   *   - a reversal is never zero. A zero row moves nothing and burns an
   *     idempotency key, so the real reversal that follows under that key is
   *     swallowed in silence.
   *
   * THE BALANCE FLOOR. The customer may already have spent the money. Posting
   * the full negative and decrementing by it would drive `balance_usd` under
   * the database's `CHECK (balance_usd >= 0)` and abort — at the exact moment
   * the money has already left. So the reversal is recorded IN FULL and the
   * part that could not be recovered is written off as `uncollectible`, which
   * is the same move `chargeInTx` already makes for a charge that outruns the
   * balance, in the opposite direction. That keeps both invariants true at
   * once, which is the whole difficulty:
   *
   *     `balance_usd = SUM(amount_usd)`   and   `balance_usd >= 0`
   *
   * and it makes money lost to reversal a single queryable SUM rather than an
   * inference from a balance that silently failed to move.
   *
   * Recovery is clamped to `balance_usd - held_usd`, not to `balance_usd`: the
   * held portion is reserved for a request already in flight against a provider
   * we will be billed for. Taking it back here would let a refund cause an
   * overdraft in a request that had already been told it could proceed.
   */
  async reverse(params: {
    /** The `idempotency_key` of the entry being reversed. */
    originalIdempotencyKey: string;
    /** Positive magnitude to reverse; the row is written negative. */
    amountUsd: Prisma.Decimal | number | string;
    /** The reversal row's OWN key — this operation is idempotent too. */
    idempotencyKey: string;
    reason: string;
    /** Voluntary ('refund') or provider-initiated ('chargeback'). */
    entryType?: ReversalEntryType;
    actor?: string;
  }): Promise<ReversalResult> {
    const amount = new Prisma.Decimal(params.amountUsd);
    if (!amount.isFinite() || !amount.greaterThan(0)) {
      throw new ReversalRefusedError(
        'invalid_amount',
        'reverse() takes the positive magnitude to reverse; the row is written negative',
      );
    }
    const reason = params.reason?.trim();
    if (!reason) {
      throw new ReversalRefusedError(
        'invalid_amount',
        'reverse() requires a reason — taking money back must be auditable',
      );
    }
    const entryType: ReversalEntryType = params.entryType ?? 'refund';
    const nil = {
      applied: false,
      reversedUsd: amount.toString(),
      recoveredUsd: '0',
      writtenOffUsd: '0',
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const original = await tx.creditsLedger.findUnique({
          where: { idempotencyKey: params.originalIdempotencyKey },
        });
        if (!original) {
          throw new ReversalRefusedError(
            'original_not_found',
            `no ledger entry with idempotency key ${params.originalIdempotencyKey}`,
          );
        }
        if (!REVERSIBLE_ENTRY_TYPES.has(original.entryType)) {
          throw new ReversalRefusedError(
            'original_not_reversible',
            `entry ${params.originalIdempotencyKey} is a '${original.entryType}'; only a credit ` +
              "('payment', 'gift', 'credit') can be reversed — undoing a charge is a credit, and " +
              'should look like one in the history',
          );
        }
        // Everything already reversed against this original, so a sequence of
        // partial refunds cannot add up past it. Summed inside the transaction
        // so two concurrent partials cannot both read the same headroom.
        const priorRows = await tx.creditsLedger.findMany({
          where: { reversalOf: params.originalIdempotencyKey },
          select: { amountUsd: true },
        });
        const alreadyReversed = priorRows.reduce(
          (acc, row) => acc.plus(row.amountUsd.abs()),
          new Prisma.Decimal(0),
        );
        const headroom = original.amountUsd.abs().minus(alreadyReversed);
        if (amount.greaterThan(headroom)) {
          throw new ReversalRefusedError(
            'exceeds_original',
            `cannot reverse ${amount.toString()} USD against ${params.originalIdempotencyKey}: ` +
              `${original.amountUsd.abs().toString()} USD was posted and ` +
              `${alreadyReversed.toString()} USD is already reversed, leaving ` +
              `${headroom.toString()} USD`,
          );
        }

        // The negative row goes in FIRST, and in full. Its unique index is what
        // rejects a replayed reversal, and it must do so before any balance has
        // moved. Provenance is copied from the original so the two are joinable
        // in a report without a lookup.
        await tx.creditsLedger.create({
          data: {
            apiKeyId: original.apiKeyId,
            amountUsd: amount.negated(),
            idempotencyKey: params.idempotencyKey,
            reason,
            entryType,
            reversalOf: params.originalIdempotencyKey,
            source: original.source,
            externalRef: original.externalRef,
            livemode: original.livemode,
            actor: params.actor ?? null,
          },
        });

        // Lock before reading: the recoverable/written-off split has to be
        // computed against a balance no concurrent settle can move underneath
        // us. `FOR UPDATE` rather than a conditional UPDATE because we need the
        // VALUE, not a yes/no.
        await tx.creditsBalance.upsert({
          where: { apiKeyId: original.apiKeyId },
          create: { apiKeyId: original.apiKeyId, balanceUsd: 0, heldUsd: 0 },
          update: {},
        });
        const locked = await tx.$queryRaw<
          { balance_usd: Prisma.Decimal; held_usd: Prisma.Decimal }[]
        >`
          SELECT balance_usd, held_usd FROM credits_balance
           WHERE api_key_id = ${original.apiKeyId} FOR UPDATE
        `;
        const balance = new Prisma.Decimal(locked[0]?.balance_usd ?? 0);
        const held = new Prisma.Decimal(locked[0]?.held_usd ?? 0);
        const spendable = Prisma.Decimal.max(balance.minus(held), 0);
        const recovered = amount.greaterThan(spendable) ? spendable : amount;
        const writtenOff = amount.minus(recovered);

        if (writtenOff.greaterThan(0)) {
          await tx.creditsLedger.create({
            data: {
              apiKeyId: original.apiKeyId,
              amountUsd: writtenOff,
              idempotencyKey: `${params.idempotencyKey}:unrecovered`,
              reason: `unrecovered:${reason}`,
              entryType: 'uncollectible',
              reversalOf: params.originalIdempotencyKey,
              actor: params.actor ?? null,
            },
          });
          this.logger.warn(
            `BILL-0008 billing: reversed ${amount.toString()} USD against a ` +
              `${spendable.toString()} USD spendable balance for api key ${original.apiKeyId}; ` +
              `${writtenOff.toString()} USD could not be recovered ` +
              `(reversal=${params.idempotencyKey}, original=${params.originalIdempotencyKey})`,
          );
        }

        if (recovered.greaterThan(0)) {
          await tx.creditsBalance.update({
            where: { apiKeyId: original.apiKeyId },
            data: { balanceUsd: { decrement: recovered } },
          });
        }

        return {
          applied: true,
          reversedUsd: amount.toString(),
          recoveredUsd: recovered.toString(),
          writtenOffUsd: writtenOff.toString(),
        };
      });
    } catch (err) {
      // A replayed reversal is a no-op, exactly like a replayed credit. The
      // whole transaction rolled back, so no balance moved either.
      if (BillingService.isDuplicateKey(err)) {
        this.logger.log(
          `billing: reversal idempotency key ${params.idempotencyKey} already posted, not reversing again`,
        );
        return nil;
      }
      throw err;
    }
  }

  /**
   * Map an optional {@link PaymentValuation} onto its columns.
   *
   * Absent stays NULL rather than becoming zero: "we did not record a rate" and
   * "the rate was zero" are different claims, and only one of them is ever
   * true.
   */
  private static valuationColumns(valuation?: PaymentValuation) {
    return {
      assetAmount:
        valuation?.assetAmount === undefined ? null : new Prisma.Decimal(valuation.assetAmount),
      asset: valuation?.asset?.trim() || null,
      usdRateAtReceipt:
        valuation?.usdRateAtReceipt === undefined
          ? null
          : new Prisma.Decimal(valuation.usdRateAtReceipt),
      valuedAt: valuation?.valuedAt ?? null,
    };
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
    provenance?: LedgerProvenance;
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
            ...(entry.provenance ?? {}),
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
