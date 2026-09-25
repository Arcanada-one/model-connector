import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { KeyRateLimitService } from './key-rate-limit.service';
import { KEY_RATE_LIMIT_REDIS_PROVIDER } from './key-rate-limit.provider';
import { RateLimitGuard } from './rate-limit.guard';
import { AbortBudgetInterceptor } from './abort-budget.interceptor';

@Module({
  providers: [
    AuthService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    // A2-301 — MUST stay after AuthGuard: it enforces a budget keyed by
    // `request.apiKey`, which AuthGuard is what sets. Nest runs APP_GUARD
    // providers in declaration order; `rate-limit.integration.spec.ts` asserts
    // the resulting behaviour against a real app rather than trusting that.
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    // DEC-AUP-0050 R7 (b) — feeds the abort budget the guard above reads.
    {
      provide: APP_INTERCEPTOR,
      useClass: AbortBudgetInterceptor,
    },
    KeyRateLimitService,
    KEY_RATE_LIMIT_REDIS_PROVIDER,
  ],
  exports: [AuthService, KeyRateLimitService],
})
export class AuthModule {}
