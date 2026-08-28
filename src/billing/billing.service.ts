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
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { InsufficientCreditsError } from './billing.errors';

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
   * Refuse the request when the balance cannot cover `estimateUsd`.
   *
   * @throws InsufficientCreditsError
   */
  async precheck(apiKeyId: string, estimateUsd: Prisma.Decimal | number): Promise<void> {
    const required = new Prisma.Decimal(estimateUsd);
    const current = await this.balance(apiKeyId);
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
    // A zero-cost request still gets a ledger row: the absence of a charge is
    // itself worth recording, and it keeps the idempotency key reserved.
    return this.post({
      apiKeyId: params.apiKeyId,
      amountUsd: amount.negated(),
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      reason: params.reason ?? 'request',
    });
  }

  /** Add credit — the operator's virtual top-up path. */
  async credit(params: {
    apiKeyId: string;
    amountUsd: Prisma.Decimal | number | string;
    idempotencyKey: string;
    reason?: string;
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
    });
  }

  /**
   * Append one signed ledger entry and move the balance by the same amount,
   * in a single transaction so the two can never diverge by a crash between
   * them.
   */
  private async post(entry: {
    apiKeyId: string;
    amountUsd: Prisma.Decimal;
    idempotencyKey: string;
    requestId?: string;
    reason: string;
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
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' // unique constraint — this key was already settled
      ) {
        this.logger.log(
          `billing: idempotency key already settled, not charging again (${entry.reason})`,
        );
        return false;
      }
      throw err;
    }
  }
}
