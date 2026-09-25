/**
 * A2-301 — DI token + narrow Redis interface for the per-key rate limiter.
 *
 * Mirrors the `CATALOG_REDIS_CLIENT` / `STT_REDIS_CLIENT` pattern already used
 * in this repository (src/connectors/catalog-redis.token.ts): a dedicated
 * ioredis connection injected behind the smallest interface the service needs,
 * so specs can drive it without a live Redis.
 *
 * Unlike the catalog cache, this Redis namespace is NOT an accelerator in front
 * of a source of truth — the counters ARE the state. `ApiKey.rateLimit` in
 * Postgres is the source of truth for the LIMIT; Redis holds the consumption.
 * That split is why a Redis outage cannot be silently ignored (see
 * `KeyRateLimitService` on the fail-closed decision).
 */
export const KEY_RATE_LIMIT_REDIS_CLIENT = Symbol('KEY_RATE_LIMIT_REDIS_CLIENT');

export interface IKeyRateLimitPipeline {
  incr(key: string): IKeyRateLimitPipeline;
  expire(key: string, seconds: number): IKeyRateLimitPipeline;
  get(key: string): IKeyRateLimitPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface IKeyRateLimitRedis {
  multi(): IKeyRateLimitPipeline;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}
