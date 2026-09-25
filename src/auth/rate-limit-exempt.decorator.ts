import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_EXEMPT_KEY = 'rateLimitExempt';

/**
 * A2-301 — exempts a route from the per-key rate limit, with the reason recorded
 * at the exemption site.
 *
 * The limiter is deliberately default-ON for every API-key-authenticated route,
 * so a new paid endpoint added later is covered without anyone remembering to
 * cover it. That makes the exemption list the thing to audit, and the reason
 * belongs next to it rather than in a commit message: `rg "@RateLimitExempt"`
 * is the whole audit.
 *
 * The `reason` is required, not optional — an exemption nobody had to justify is
 * the failure mode this argument exists to prevent.
 */
export const RateLimitExempt = (reason: string) => SetMetadata(RATE_LIMIT_EXEMPT_KEY, reason);
