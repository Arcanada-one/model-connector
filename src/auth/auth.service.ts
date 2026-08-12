import { Injectable } from '@nestjs/common';
import { compare } from 'bcryptjs';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CONN-1668: verified-key cache. `validateKey` runs on EVERY authenticated
 * request and bcrypt-compares the raw key against ALL active keys with bcryptjs
 * — pure JS, on the main event loop. Measured on prod 2026-08-12: an authed
 * request (GET /v1/models) took ~1.4s of event-loop-blocking bcrypt vs 0.6ms
 * for the unauthenticated /health, and it scales linearly with the key count
 * (69 active keys at measurement time). This is the same fault that melted Ops
 * Bot into fleet-wide 504 (AGENT-0146). Agents reuse one long-lived key, so a
 * successful bcrypt only needs to happen once per key per process: cache
 * sha256(rawKey) -> identity with a TTL, and cache failures briefly so a
 * misconfigured caller cannot force an O(N) bcrypt sweep on every request.
 * Admin create/revoke flush the cache (single process, cheap).
 */
@Injectable()
export class AuthService {
  private static readonly VERIFY_CACHE_TTL_MS = 5 * 60_000;
  private static readonly VERIFY_NEGATIVE_TTL_MS = 60_000;
  private readonly verifyCache = new Map<
    string,
    { identity: { id: string; name: string } | null; expiresAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  private static cacheKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  /** Flush the verified-key cache (on key create/revoke, and in tests). */
  flushVerifyCache(): void {
    this.verifyCache.clear();
  }

  async validateKey(rawKey: string): Promise<{ id: string; name: string } | null> {
    const cacheKey = AuthService.cacheKey(rawKey);
    const cached = this.verifyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.identity;

    const keys = await this.prisma.apiKey.findMany({ where: { active: true } });
    for (const key of keys) {
      const match = await compare(rawKey, key.keyHash);
      if (match) {
        const identity = { id: key.id, name: key.name };
        this.verifyCache.set(cacheKey, {
          identity,
          expiresAt: Date.now() + AuthService.VERIFY_CACHE_TTL_MS,
        });
        return identity;
      }
    }
    this.verifyCache.set(cacheKey, {
      identity: null,
      expiresAt: Date.now() + AuthService.VERIFY_NEGATIVE_TTL_MS,
    });
    return null;
  }
}
