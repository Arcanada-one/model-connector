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
import { BillingService } from './billing.service';

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
    .refine((v) => Number(v) > 0, 'a gift must be greater than zero — gifts only add credit'),
  idempotencyKey: z.string().min(8).max(200),
  reason: z.string().trim().min(3).max(200),
});

const CreditSchema = z.object({
  amountUsd: z
    .union([z.number(), z.string()])
    .refine((v) => Number(v) > 0, 'amountUsd must be positive'),
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
  constructor(private readonly billing: BillingService) {}

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
