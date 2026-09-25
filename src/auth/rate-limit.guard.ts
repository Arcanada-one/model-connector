import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_EXEMPT_KEY } from './rate-limit-exempt.decorator';
import {
  ABORT_BUDGET_THRESHOLD,
  ABORT_BUDGET_WINDOW_SECONDS,
  KeyRateLimitService,
  RateLimitDecision,
} from './key-rate-limit.service';
// reuse: in-repo `retryAfterFields` — the single definition of the ms/seconds
// pair this service puts on the wire (A2-207 fixed a unit bug there; a second
// hand-rolled copy here would be free to regress it again).
import { retryAfterFields } from '../connectors/interfaces/connector.interface';

interface RateLimitedRequest {
  apiKey?: { id: string };
}

/**
 * A2-301 — enforces `ApiKey.rateLimit` on every API-key-authenticated route.
 *
 * Runs after `AuthGuard`, which is what puts `request.apiKey` there; with no
 * `apiKey` on the request there is nothing to key a per-key budget on, and the
 * guard steps aside. That covers `@Public()` routes (health, `/admin/keys`
 * behind `AdminGuard`, `/stats` behind `StatsReadGuard`) without an exemption
 * each: those authenticate with something other than an API key, so a per-key
 * limit is not the control that applies to them. Ordering is not assumed from
 * documentation — `rate-limit.integration.spec.ts` drives a real Nest app and
 * fails if this guard ever runs before the key is resolved.
 *
 * Metadata reads (`GET /connectors`, `/connectors/catalog`, `/v1/models`) share
 * the one per-key budget on purpose. They are cheap, but "cheap" is not "free",
 * and a second budget would be a second thing to tune; a client that genuinely
 * needs more headroom should get a higher `rateLimit`, not an exemption.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly rateLimit: KeyRateLimitService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const exemptReason = this.reflector.getAllAndOverride<string>(RATE_LIMIT_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exemptReason) return true;

    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    const keyId = request.apiKey?.id;
    // No API key on the request: either a @Public() route or one guarded by a
    // different principal (admin token, stats token). Nothing to limit per key.
    if (!keyId) return true;

    const decision = await this.rateLimit.consume(keyId);
    if (decision.outcome === 'allowed') return true;

    this.refuse(context, keyId, decision);
  }

  private refuse(context: ExecutionContext, keyId: string, decision: RateLimitDecision): never {
    // Only the key id is ever logged. The raw key and its hash stay out of logs
    // by construction: this guard never sees them (AuthGuard consumed the token
    // and put an identity on the request).
    this.logger.warn(
      `rate limit refusal keyId=${keyId} outcome=${decision.outcome} ` +
        `count=${decision.count} limit=${decision.limit} aborts=${decision.abortCount} ` +
        `retryAfterSeconds=${decision.retryAfterSeconds}`,
    );

    const reply = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
    // RFC 9110: `Retry-After` is SECONDS on the wire.
    reply?.header?.('Retry-After', String(decision.retryAfterSeconds));

    if (decision.outcome === 'backend_unavailable') {
      // 503, not 429 — see KeyRateLimitService.consume on fail-closed. Claiming
      // the caller exceeded a quota they did not exceed would be a false
      // statement about their own usage, and clients branch on the status.
      throw new HttpException(
        {
          error: 'service_unavailable',
          message:
            'Rate limiting backend is unavailable; the request was refused rather than ' +
            'admitted unmetered. Retry after the interval below.',
          ...retryAfterFields(decision.retryAfterSeconds * 1_000),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const message =
      decision.outcome === 'abort_budget_exhausted'
        ? `Aborted-attempt budget exhausted for this API key: ${decision.abortCount} billable ` +
          `aborted attempts in ${ABORT_BUDGET_WINDOW_SECONDS}s, threshold ` +
          `${ABORT_BUDGET_THRESHOLD}. A provider bills an aborted non-streaming request in ` +
          'full, so the key is degraded until the window rolls over.'
        : `Rate limit exceeded for this API key: ${decision.count} requests in the current ` +
          `window, limit ${decision.limit}.`;

    throw new HttpException(
      {
        error: 'rate_limited',
        message,
        ...retryAfterFields(decision.retryAfterSeconds * 1_000),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
