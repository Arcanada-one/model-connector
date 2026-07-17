import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * CTRL-0026 Phase 2 — purpose-scoped guard for GET /stats/requests/daily.
 *
 * Modeled on src/admin/admin.guard.ts (timingSafeEqual, length-check before
 * compare, fail-closed on any missing piece) but is a DELIBERATELY separate
 * guard/token: stats reads must never accept ADMIN_TOKEN or an inference
 * ApiKey (threat T2 in datarim/plans/CTRL-0026-plan.md).
 */
@Injectable()
export class StatsReadGuard implements CanActivate {
  private readonly logger = new Logger(StatsReadGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-stats-token'] as string | string[] | undefined;
    const expected = process.env.STATS_READ_TOKEN;

    if (!expected) {
      return this.deny('no-expected-token');
    }
    if (!token) {
      return this.deny('missing-token');
    }
    // Fastify/Nest deliver a duplicate header as string[]. Silently picking
    // the first element would change auth semantics; reject outright instead.
    if (Array.isArray(token)) {
      return this.deny('duplicate-header');
    }
    if (token.length !== expected.length) {
      return this.deny('length-mismatch');
    }
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return this.deny('token-mismatch');
    }

    return true;
  }

  // Single log call site for every failure path (threat T10 — detection
  // signal on a public route). Emits a redacted reason code only; never the
  // header value or the expected token.
  private deny(reason: string): false {
    this.logger.warn(`stats-read auth denied: reason=${reason}`);
    return false;
  }
}
