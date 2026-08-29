import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { secretsMatch } from '../common/secret-compare';

/**
 * ARAS-0058 (consilium §6.2) — the third copy of the byte-length crash-oracle.
 *
 * The consilium found the defect in `AdminGuard` and noted `StatsReadGuard` had
 * inherited it. This guard had it too, uncited: same UTF-16 `token.length`
 * pre-check in front of the same UTF-8 `timingSafeEqual`. Three copies is why
 * the comparison now lives in one place — see `src/common/secret-compare.ts`.
 */
@Injectable()
export class WatcherRepairGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-watcher-repair-token'] as string | string[] | undefined;
    const expected = process.env.WATCHER_REPAIR_TOKEN;

    if (!expected || !token) return false;
    if (Array.isArray(token)) return false;

    return secretsMatch(token, expected);
  }
}
