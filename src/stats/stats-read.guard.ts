import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';

import { secretsMatch } from '../common/secret-compare';

/**
 * CTRL-0026 Phase 2 — purpose-scoped guard for GET /stats/requests/daily.
 *
 * Modeled on src/admin/admin.guard.ts (constant-time compare, fail-closed on
 * any missing piece) but is a DELIBERATELY separate guard/token: stats reads
 * must never accept ADMIN_TOKEN or an inference ApiKey (threat T2 in
 * datarim/plans/CTRL-0026-plan.md).
 *
 * ARAS-0058 (consilium §6.2): it was modeled on admin.guard closely enough to
 * inherit its byte-length crash-oracle — `token.length !== expected.length`
 * (UTF-16) guarding a `timingSafeEqual` over UTF-8 buffers. Both now compare
 * through `secretsMatch`, which cannot throw and has no length pre-check to
 * report a mismatch cheaply.
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
    // No length pre-check: 'this token is the right length' was itself a free
    // answer, and the pre-check is what made the comparison able to throw.
    if (!secretsMatch(token, expected)) {
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
