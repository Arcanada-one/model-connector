/**
 * ARAS-0058 — the compensating control the original design named and never
 * built.
 *
 * `settleSpend`'s docstring justified being non-fatal on the grounds that "the
 * ledger's absence is recoverable from the Request row, which is written
 * first". That recovery job did not exist. A design that names its own
 * compensating control and does not build it has not mitigated the risk, it
 * has documented it — and in the meantime the fire-and-forget settle path
 * silently dropped charges whose only trace was an ERROR line in a log nobody
 * alerts on.
 *
 * This is that job: find `Request` rows carrying measured spend with no
 * matching ledger entry, and settle them. Plus two pieces of hygiene the hold
 * mechanism requires — releasing reservations whose owner never came back, and
 * forgetting request intents past their replay window.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { getConfig } from '../config/env.schema';

/** One unsettled request, as the anti-join returns it. */
export interface UnsettledRequest {
  id: string;
  apiKeyId: string;
  costUsd: Prisma.Decimal;
  createdAt: Date;
}

export interface ReconcileReport {
  scanned: number;
  settled: number;
  alreadySettled: number;
  failed: number;
  totalUsd: string;
  dryRun: boolean;
}

/**
 * How recent a request must be to be reconciled automatically.
 *
 * A bound, not an optimisation. Production carries `Request` rows that pre-date
 * the credits tables existing at all — they were never settled because there
 * was nowhere to settle them TO. Reconciling those on the first tick after a
 * deploy would charge every account for months of historic usage in one go, as
 * a side effect of shipping a bug fix. The automatic sweep therefore only ever
 * looks at the recent past; a deliberate backfill is an operator decision made
 * against an explicit window, not something a cron does on its own.
 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How settled a request must be before it counts as orphaned.
 *
 * Settlement is now transactional with the `Request` row's own insert, so on
 * the current code path there is no window at all. The grace period is for the
 * rows the OLD path wrote, and for anything a future caller adds that settles
 * out of band — reconciling a request that is merely still in flight would race
 * the live settle, and while the ledger's unique key would reject the second
 * charge, "the constraint saved us" is not a design.
 */
const DEFAULT_GRACE_MS = 5 * 60 * 1000;

@Injectable()
export class BillingReconcilerService {
  private readonly logger = new Logger(BillingReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  /**
   * `Request` rows with measured spend and no ledger entry against them.
   *
   * A LEFT JOIN anti-join rather than two round trips, because the interesting
   * case is "thousands of rows, none of them orphaned" and that should cost one
   * indexed scan. `credits_ledger.request_id` is indexed for exactly this
   * (see the ARAS-0058 migration).
   */
  async findUnsettled(opts: { limit?: number; maxAgeMs?: number; graceMs?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5_000);
    const now = Date.now();
    const oldest = new Date(now - (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
    const newest = new Date(now - (opts.graceMs ?? DEFAULT_GRACE_MS));

    return this.prisma.$queryRaw<UnsettledRequest[]>`
      SELECT r."id", r."apiKeyId", r."costUsd", r."createdAt"
        FROM "Request" r
        LEFT JOIN "credits_ledger" l ON l."request_id" = r."id"
       WHERE r."costUsd" > 0
         AND r."createdAt" >= ${oldest}
         AND r."createdAt" <  ${newest}
         AND l."id" IS NULL
       ORDER BY r."createdAt" ASC
       LIMIT ${limit}
    `;
  }

  /**
   * Settle every orphaned request found.
   *
   * Keyed on `request:<id>`, deliberately the same key the pre-ARAS-0058
   * settle path used, so a row that path half-settled cannot be charged a
   * second time here. `settle()` owns its own transaction and absorbs the
   * unique-constraint rejection, which is why this uses it rather than
   * `settleInTx`: two reconcilers racing is an expected condition, not a fault.
   *
   * A failure on one request does not abandon the rest. The whole point of a
   * recovery job is that it makes progress on a bad day.
   */
  async reconcile(
    opts: { limit?: number; maxAgeMs?: number; graceMs?: number; dryRun?: boolean } = {},
  ): Promise<ReconcileReport> {
    const dryRun = opts.dryRun ?? false;
    const orphans = await this.findUnsettled(opts);

    let settled = 0;
    let alreadySettled = 0;
    let failed = 0;
    let total = new Prisma.Decimal(0);

    for (const row of orphans) {
      const amount = new Prisma.Decimal(row.costUsd);
      total = total.plus(amount);
      if (dryRun) continue;
      try {
        const applied = await this.billing.settle({
          apiKeyId: row.apiKeyId,
          amountUsd: amount,
          idempotencyKey: `request:${row.id}`,
          requestId: row.id,
          reason: 'reconciled-request',
        });
        if (applied) {
          settled += 1;
          this.logger.warn(
            `ARAS-0058 reconciler: settled orphaned spend of ${amount.toString()} USD for ` +
              `request ${row.id} (api key ${row.apiKeyId}, dispatched ${row.createdAt.toISOString()}). ` +
              'A charge reaching this job means the settle path did not complete when the request ran.',
          );
        } else {
          alreadySettled += 1;
        }
      } catch (err) {
        failed += 1;
        this.logger.error(
          `ARAS-0058 reconciler: failed to settle request ${row.id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return {
      scanned: orphans.length,
      settled,
      alreadySettled,
      failed,
      totalUsd: total.toString(),
      dryRun,
    };
  }

  /**
   * Hourly maintenance.
   *
   * The two halves have deliberately different postures:
   *
   *   - the SWEEP always runs. It gives money BACK — a hold whose owner was
   *     SIGKILLed mid-dispatch otherwise freezes a customer's funds forever,
   *     and the customer's only symptom is a balance that says one thing and a
   *     spendable balance that says another. Nothing about that needs an
   *     operator's permission.
   *   - the RECONCILER only runs when switched on. It CHARGES, and a job that
   *     charges must not start doing so as a side effect of a deploy. The
   *     admin endpoint offers a dry run so an operator can see the bill before
   *     authorising it.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async maintenance(): Promise<void> {
    try {
      const sweep = await this.billing.sweepExpiredIntents();
      if (sweep.swept > 0) {
        this.logger.warn(
          `ARAS-0058 billing: released ${sweep.releasedUsd} USD from ${sweep.swept} abandoned hold(s)`,
        );
      }
      const purged = await this.billing.purgeSettledIntents(this.retentionMs());
      if (purged > 0) {
        this.logger.log(`ARAS-0058 billing: purged ${purged} expired request intent(s)`);
      }
    } catch (err) {
      this.logger.error(
        `ARAS-0058 billing: hold maintenance failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!this.reconcileEnabled()) return;
    try {
      const report = await this.reconcile();
      if (report.settled > 0 || report.failed > 0) {
        this.logger.warn(
          `ARAS-0058 reconciler: ${report.settled} settled, ${report.alreadySettled} already settled, ` +
            `${report.failed} failed, ${report.totalUsd} USD scanned`,
        );
      }
    } catch (err) {
      this.logger.error(
        `ARAS-0058 reconciler: sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Config read defensively, and NOT at construction time.
   *
   * `@Cron` handlers run in a scheduler tick with no request context, so an env
   * problem here surfaces as an unhandled rejection inside the scheduler rather
   * than as a failed request. Reading per tick also means an operator's change
   * takes effect on the next tick rather than needing a restart.
   */
  private reconcileEnabled(): boolean {
    try {
      return getConfig().BILLING_RECONCILE_ENABLED === true;
    } catch {
      return false;
    }
  }

  private retentionMs(): number {
    try {
      return getConfig().BILLING_INTENT_RETENTION_MS;
    } catch {
      return 24 * 60 * 60 * 1000;
    }
  }
}
