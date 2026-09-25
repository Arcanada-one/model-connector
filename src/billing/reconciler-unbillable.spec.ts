/**
 * A2-299b / DEC-AUP-0050 R2 — the reconciler is the THIRD settlement path, and
 * it charged `Request.costUsd` without asking where the number came from.
 *
 * The card for A2-299b asked whether any path other than the live settle reads
 * `response.usage.costUsd` or the `Request` row's cost to charge the customer
 * later. This is it. `findUnsettled` selects `Request` rows with `costUsd > 0`
 * and no matching ledger entry; `reconcile` charges `costUsd` to the account
 * under the reason `reconciled-request`.
 *
 * That was sound until DEC-AUP-0050. `costUsd > 0` used to mean "the customer
 * received metered tokens and owes for them". `'estimated-input-unbilled'` broke
 * the equivalence: the row records OUR estimate of what an attempt cost us,
 * settled at $0 on the live path precisely because R2 forbids charging it. The
 * recovery job would have charged it in full.
 *
 * WHY THIS FILE IS A UNIT SPEC, NOT AN INTEGRATION ONE. The reconciler's
 * existing tests live in `reconciler.integration.spec.ts`, and
 * `vitest.config.ts` EXCLUDES `*.integration.spec.ts` from the default run —
 * which is the only test command CI executes (`.github/workflows/ci.yml`:
 * `pnpm test`). So none of the reconciler's tests run in CI today. A guard on a
 * job that charges customers must be defended by a test that actually runs, so
 * the invariant is enforced in `reconcile()` (in code, over the rows) as well as
 * in the SQL, and this spec drives it against a stubbed query.
 *
 * The stub is on `findUnsettled` — the DB read — and nothing else: the decision
 * under test, the loop and the call into `BillingService.settle`, are the real
 * ones. The SQL predicate's own behaviour is covered in the integration sibling,
 * where a mock could not prove it.
 */

import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import { BillingReconcilerService, type UnsettledRequest } from './reconciler.service';
import type { BillingService } from './billing.service';
import type { PrismaService } from '../prisma/prisma.service';

const KEY = 'key-1';

function row(opts: { id: string; costUsd: string; costSource: string | null }): UnsettledRequest {
  return {
    id: opts.id,
    apiKeyId: KEY,
    costUsd: new Prisma.Decimal(opts.costUsd),
    createdAt: new Date(Date.now() - 30 * 60 * 1000),
    costSource: opts.costSource,
  };
}

/**
 * The reconciler with a real `reconcile()` over a supplied batch of orphans.
 *
 * `settle` is a spy because the assertion that matters is whether it is called
 * AT ALL and with what — "the customer was charged" is a question about the
 * charge being attempted, and a real BillingService would need a database to
 * answer it without adding anything to what is being tested here.
 */
function stand(rows: UnsettledRequest[]) {
  const settle = vi.fn().mockResolvedValue(true);
  const billing = { settle } as unknown as BillingService;
  const reconciler = new BillingReconcilerService({} as PrismaService, billing);
  vi.spyOn(reconciler, 'findUnsettled').mockResolvedValue(rows as never);
  return { reconciler, settle };
}

describe("A2-299b — the reconciler must not charge a cost that is ours, not the customer's", () => {
  it('refuses to charge an aborted attempt, and says so in the report', async () => {
    const { reconciler, settle } = stand([
      row({ id: 'aborted-1', costUsd: '0.0174', costSource: 'estimated-input-unbilled' }),
    ]);

    const report = await reconciler.reconcile();

    // The charge was never attempted. This is the whole rule: R2 says the
    // customer pays nothing for an attempt our own timeout aborted, and a
    // recovery job is not an exception to it.
    expect(settle).not.toHaveBeenCalled();
    expect(report.settled).toBe(0);

    // And it is not silent. A skipped row is reported with its amount, so
    // "settled: 0" cannot be confused with "found nothing", and the money we
    // are choosing not to collect is a number an operator can see.
    expect(report.scanned).toBe(1);
    expect(report.skippedUnbillable).toBe(1);
    expect(report.unbillableUsd).toBe('0.0174');
    // `totalUsd` keeps meaning "what this job would collect", so our own cost
    // does not inflate it.
    expect(report.totalUsd).toBe('0');
  });

  it('CONTROL: ordinary metered spend with no ledger entry IS still settled', async () => {
    // The reconciler exists to collect this. A guard that stopped it would turn
    // a fix for over-charging into a revenue leak, so the control is as
    // load-bearing as the rule.
    const { reconciler, settle } = stand([
      row({ id: 'orphan-1', costUsd: '0.25', costSource: 'catalog' }),
    ]);

    const report = await reconciler.reconcile();

    expect(settle).toHaveBeenCalledTimes(1);
    const params = settle.mock.calls[0][0] as {
      apiKeyId: string;
      amountUsd: Prisma.Decimal;
      idempotencyKey: string;
      reason: string;
    };
    expect(params.apiKeyId).toBe(KEY);
    expect(params.amountUsd.toString()).toBe('0.25');
    expect(params.idempotencyKey).toBe('request:orphan-1');
    expect(params.reason).toBe('reconciled-request');
    expect(report.settled).toBe(1);
    expect(report.skippedUnbillable).toBe(0);
    expect(report.totalUsd).toBe('0.25');
  });

  it('CONTROL: a legacy row with NO costSource is still settled', async () => {
    // Rows written before ARAS-0058 carry `costSource: null`. They are ordinary
    // metered spend, and treating "unknown" as unbillable would quietly stop
    // collecting real revenue — the opposite failure, and a harder one to
    // notice.
    const { reconciler, settle } = stand([
      row({ id: 'legacy-1', costUsd: '0.10', costSource: null }),
    ]);

    const report = await reconciler.reconcile();

    expect(settle).toHaveBeenCalledTimes(1);
    expect(report.settled).toBe(1);
    expect(report.skippedUnbillable).toBe(0);
  });

  it('settles the billable rows in a mixed batch and skips only the unbillable one', async () => {
    // A batch is the realistic case, and the failure mode to rule out is a
    // `continue` that abandons the rest of the run.
    const { reconciler, settle } = stand([
      row({ id: 'aborted-1', costUsd: '0.0174', costSource: 'estimated-input-unbilled' }),
      row({ id: 'orphan-1', costUsd: '0.25', costSource: 'catalog' }),
      row({ id: 'aborted-2', costUsd: '0.0100', costSource: 'estimated-input-unbilled' }),
      row({ id: 'orphan-2', costUsd: '1.00', costSource: 'provider' }),
    ]);

    const report = await reconciler.reconcile();

    expect(settle).toHaveBeenCalledTimes(2);
    const charged = settle.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(charged).toEqual(['request:orphan-1', 'request:orphan-2']);
    expect(report.scanned).toBe(4);
    expect(report.settled).toBe(2);
    expect(report.skippedUnbillable).toBe(2);
    expect(report.totalUsd).toBe('1.25');
    expect(report.unbillableUsd).toBe('0.0274');
  });

  it('a DRY RUN does not report our own cost as collectable either', async () => {
    // The dry run is what an operator reads before authorising the job. If it
    // quoted the aborted attempts in `totalUsd`, the authorisation would be
    // given for a bill that must never be issued.
    const { reconciler, settle } = stand([
      row({ id: 'aborted-1', costUsd: '0.0174', costSource: 'estimated-input-unbilled' }),
      row({ id: 'orphan-1', costUsd: '0.25', costSource: 'catalog' }),
    ]);

    const report = await reconciler.reconcile({ dryRun: true });

    expect(settle).not.toHaveBeenCalled();
    expect(report.dryRun).toBe(true);
    expect(report.totalUsd).toBe('0.25');
    expect(report.unbillableUsd).toBe('0.0174');
  });
});
