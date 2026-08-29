/**
 * ARAS-0064 — operator-facing credits surface.
 *
 * Without this the billing layer is unusable: `credit()` existed but nothing
 * an operator could call, so every account sat at zero and enabling
 * enforcement would have denied everyone. This is the path that puts the
 * operator's virtual balance in, as the first ledger entry.
 *
 * Admin-guarded, on the same `AdminGuard` as key management: adding money is
 * at least as sensitive as issuing an API key.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../auth/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { BillingService, MAX_CREDIT_USD } from './billing.service';
import { BillingReconcilerService } from './reconciler.service';

/**
 * ARAS-0071 — a gift. Stricter than a plain credit on purpose.
 *
 * `reason` is REQUIRED and non-trivial: a gift is money appearing from nowhere,
 * and the ledger has to answer "why does this account have this balance"
 * without anyone having to remember. A 3-character floor keeps "x" from
 * satisfying the rule while still allowing a terse real answer.
 */
const GiftSchema = z.object({
  amountUsd: z
    .union([z.number(), z.string()])
    .refine((v) => Number.isFinite(Number(v)), 'amountUsd must be a finite number')
    .refine((v) => Number(v) > 0, 'a gift must be greater than zero — gifts only add credit')
    // BILL-0008 — the same ceiling as a credit. A gift creates balance by
    // identical arithmetic and is equally un-postable, so exempting it would
    // leave the bound in place on the path an attacker cares about least.
    .refine(
      (v) => Number(v) <= MAX_CREDIT_USD,
      `amountUsd must not exceed ${MAX_CREDIT_USD} — there is no un-post`,
    ),
  idempotencyKey: z.string().min(8).max(200),
  reason: z.string().trim().min(3).max(200),
});

/**
 * `dryRun` defaults to true — see the endpoint's docstring. `maxAgeMs` is
 * capped at 90 days so a typo cannot turn a routine sweep into a backfill of
 * everything the system has ever done.
 */
const ReconcileSchema = z.object({
  dryRun: z.boolean().default(true),
  limit: z.number().int().min(1).max(5_000).optional(),
  maxAgeMs: z
    .number()
    .int()
    .min(60_000)
    .max(90 * 86_400_000)
    .optional(),
  graceMs: z.number().int().min(0).max(86_400_000).optional(),
});

/**
 * BILL-0008 (consilium §6.3) — `CreditSchema` accepted `Infinity`.
 *
 * It refined only `Number(v) > 0`, and `Number("Infinity") > 0` is true.
 * `GiftSchema` above has had the `Number.isFinite` refine all along, so the two
 * schemas guarding the same money differed in exactly the way that mattered,
 * and the weaker one was the top-up path. `Infinity` then survives
 * `credit()`'s `greaterThan(0)` because `new Prisma.Decimal(Infinity)` is a
 * valid Decimal that compares greater than everything.
 *
 * The ceiling is the second half and is not implied by the first: "finite" is
 * not a bound. `MAX_CREDIT_USD` is set below the width of
 * `credits_balance.balance_usd` itself — see its docstring — so an oversized
 * credit is refused by a rule with a reason rather than by a Postgres numeric
 * overflow at the moment money has already been received.
 */
const CreditSchema = z.object({
  amountUsd: z
    .union([z.number(), z.string()])
    .refine((v) => Number.isFinite(Number(v)), 'amountUsd must be a finite number')
    .refine((v) => Number(v) > 0, 'amountUsd must be positive')
    .refine(
      (v) => Number(v) <= MAX_CREDIT_USD,
      `amountUsd must not exceed ${MAX_CREDIT_USD} — a larger single credit is a typo or an attack, and there is no un-post`,
    ),
  // Required, not generated: a top-up is money, and the caller must be able to
  // retry a request it is unsure landed WITHOUT adding funds twice. Generating
  // a key here would make every retry a fresh credit.
  idempotencyKey: z.string().min(8).max(200),
  reason: z.string().max(200).optional(),
});

@Controller('admin/credits')
@UseGuards(AdminGuard)
@Public()
export class CreditsController {
  constructor(
    private readonly billing: BillingService,
    private readonly reconciler: BillingReconcilerService,
  ) {}

  /**
   * ARAS-0058 — find measured spend that never reached the ledger, and
   * optionally settle it.
   *
   * `dryRun` defaults to TRUE. This endpoint charges real accounts, and the
   * operator asking "what did we miss?" and the operator saying "now bill for
   * it" are two different decisions; making the safe one the default keeps a
   * curious `curl` from becoming an invoice.
   */
  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Body() body: unknown) {
    const parsed = ReconcileSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }
    return this.reconciler.reconcile(parsed.data);
  }

  /**
   * ARAS-0058 — release reservations whose owner never came back.
   *
   * Runs hourly on its own; exposed so an operator recovering from an incident
   * does not have to wait for the tick. Safe to call at any time: it only ever
   * gives money back, and only for holds already past their expiry.
   */
  @Post('holds/sweep')
  @HttpCode(HttpStatus.OK)
  async sweepHolds() {
    return this.billing.sweepExpiredIntents();
  }

  @Get(':apiKeyId')
  async balance(@Param('apiKeyId') apiKeyId: string) {
    const balance = await this.billing.balance(apiKeyId);
    return { apiKeyId, balanceUsd: balance.toString() };
  }

  /** Ledger history — gifts and charges are distinguishable by `entryType`. */
  @Get(':apiKeyId/history')
  async history(@Param('apiKeyId') apiKeyId: string) {
    const entries = await this.billing.history(apiKeyId);
    return {
      apiKeyId,
      entries: entries.map((e) => ({
        id: e.id,
        entryType: e.entryType,
        amountUsd: e.amountUsd.toString(),
        reason: e.reason,
        requestId: e.requestId,
        // BILL-0008 — provenance the operator can actually see. Storing it and
        // never surfacing it would mean the only way to answer "where did this
        // money come from" is a psql session on the production database.
        source: e.source,
        externalRef: e.externalRef,
        livemode: e.livemode,
        reversalOf: e.reversalOf,
        actor: e.actor,
        createdAt: e.createdAt,
      })),
    };
  }

  /**
   * ARAS-0071 — grant credit the recipient did not pay for.
   *
   * Behind the same `AdminGuard` as key management (`x-admin-token`, compared
   * with `timingSafeEqual`). Creating money is at least as sensitive as
   * issuing an API key, so it reuses that surface rather than introducing a
   * second, less-reviewed one.
   */
  @Post(':apiKeyId/gift')
  @HttpCode(HttpStatus.OK)
  async gift(@Param('apiKeyId') apiKeyId: string, @Body() body: unknown) {
    const parsed = GiftSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }
    const applied = await this.billing.gift({
      apiKeyId,
      amountUsd: parsed.data.amountUsd,
      idempotencyKey: parsed.data.idempotencyKey,
      reason: parsed.data.reason,
    });
    const balance = await this.billing.balance(apiKeyId);
    // `applied: false` means the key was already used — a retry did NOT gift
    // again. Reported explicitly so a repeated call is never mistaken for a
    // second grant.
    return { apiKeyId, applied, entryType: 'gift', balanceUsd: balance.toString() };
  }

  @Post(':apiKeyId')
  @HttpCode(HttpStatus.OK)
  async credit(@Param('apiKeyId') apiKeyId: string, @Body() body: unknown) {
    const parsed = CreditSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }
    const applied = await this.billing.credit({
      apiKeyId,
      amountUsd: parsed.data.amountUsd,
      idempotencyKey: parsed.data.idempotencyKey,
      reason: parsed.data.reason ?? 'operator-topup',
    });
    const balance = await this.billing.balance(apiKeyId);
    // `applied: false` means the key was already used — the caller retried and
    // we did NOT add funds again. Reported explicitly so a retry is not
    // mistaken for a second successful top-up.
    return { apiKeyId, applied, balanceUsd: balance.toString() };
  }
}
