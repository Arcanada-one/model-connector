import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { secretsMatch } from '../common/secret-compare';

/**
 * ARAS-0058 (consilium §6.2) — the byte-length crash-oracle is gone.
 *
 * This guard used to compare `token.length` (UTF-16 code units) and then
 * `timingSafeEqual(Buffer.from(token), Buffer.from(expected))` (UTF-8 bytes).
 * A multi-byte character at equal STRING length slipped past the pre-check and
 * made `timingSafeEqual` throw `RangeError` — a 500 where every other bad
 * token gets a 403, which is a probe that reads back the byte length of
 * `ADMIN_TOKEN`. See `src/common/secret-compare.ts` for why hashing first
 * fixes it and why the length check is not merely reordered but deleted.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-admin-token'] as string | string[] | undefined;
    const expected = process.env.ADMIN_TOKEN;

    if (!expected || !token) return false;
    // Fastify delivers a duplicated header as an array. Picking the first
    // element would silently change auth semantics; refuse instead.
    if (Array.isArray(token)) return false;

    return secretsMatch(token, expected);
  }
}
