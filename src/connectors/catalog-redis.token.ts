import { getConfig } from '../config/env.schema';

/**
 * CONN-0245 — DI token + narrow interface for the catalog's Redis cache client.
 *
 * Mirrors the `STT_REDIS_CLIENT` pattern (src/speech/stt/stt-quota.service.ts):
 * a dedicated ioredis connection, injected behind a minimal interface so specs
 * can mock it without pulling in a real ioredis instance. The catalog DB
 * (ModelCatalog table) is the source of truth; this cache is a short-TTL
 * accelerator in front of the DB read path only — never a fallback source of
 * truth on its own.
 */
export const CATALOG_REDIS_CLIENT = Symbol('CATALOG_REDIS_CLIENT');

export interface ICatalogRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  // A2-464 — invalidation walks an index set of the keys THIS instance wrote
  // (`<REDIS_PREFIX>catalog:index`), not `KEYS conn:catalog:*`. KEYS is O(N)
  // over the whole database and blocks Redis while it runs, and its unprefixed
  // pattern erased the cache of every other instance on a shared Redis.
  // `keys` is deliberately absent from this interface so it cannot come back.
  sadd(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  pexpire(key: string, ttlMs: number): Promise<unknown>;
  // Readiness probe (health/ready) — reported as a degradation, never a failure.
  ping(): Promise<string>;
}

/** `<REDIS_PREFIX>catalog:` — every catalog cache key lives under the instance's own prefix. */
export function catalogCacheNamespace(redisPrefix: string): string {
  return `${redisPrefix}catalog:`;
}

/** The set that lists every cache key this instance wrote; invalidation walks it. */
export function catalogCacheIndexKey(redisPrefix: string): string {
  return `${catalogCacheNamespace(redisPrefix)}index`;
}

/**
 * The instance's REDIS_PREFIX, or the env.schema default (`conn:`) when the full
 * env cannot be validated (unit tests) — same defensive pattern as the other
 * catalog config reads in ConnectorsService.
 */
export function catalogRedisPrefix(): string {
  try {
    return getConfig().REDIS_PREFIX;
  } catch {
    return 'conn:';
  }
}
