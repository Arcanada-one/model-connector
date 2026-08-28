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
