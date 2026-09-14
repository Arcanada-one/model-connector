// AUP-CACHE-006 (enforce0) — owner surface for the prompt-cache policy:
// read the state, switch the mode WITH a receipt, read recent typed events.
// Guarded by the admin token like the circuit-breaker reset.

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin.guard';
import { Public } from '../auth/public.decorator';
import { POLICY_MODES } from './prompt-cache-policy';
import { PromptCachePolicyService } from './prompt-cache-policy.service';

export const SetPolicyModeSchema = z
  .object({
    mode: z.enum(POLICY_MODES as unknown as [string, ...string[]]),
    /** Who decided (a person or a runbook id) — recorded on the receipt. */
    actor: z.string().min(1).max(200),
    /** Why — recorded on the receipt; a switch without a reason is refused. */
    reason: z.string().min(10).max(2000),
  })
  .strict();

@Controller('admin/prompt-cache')
@UseGuards(AdminGuard)
@Public()
export class PromptCacheAdminController {
  constructor(private readonly policy: PromptCachePolicyService) {}

  @Get('policy')
  getPolicy() {
    return this.policy.getState();
  }

  @Post('policy/mode')
  @HttpCode(HttpStatus.OK)
  setMode(@Body() body: unknown) {
    const parsed = SetPolicyModeSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { error: 'validation_error', issues: parsed.error.issues },
        HttpStatus.BAD_REQUEST,
      );
    }
    const { mode, actor, reason } = parsed.data;
    return this.policy.setMode(mode as (typeof POLICY_MODES)[number], { actor, reason });
  }

  @Get('events')
  getEvents(@Query('limit') limit?: string) {
    const n = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      throw new HttpException(
        { error: 'validation_error', message: 'limit must be an integer in 1..500' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const events = this.policy.recentEvents(n);
    return { count: events.length, events };
  }
}
