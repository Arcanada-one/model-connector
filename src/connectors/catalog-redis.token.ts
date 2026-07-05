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
  del(key: string): Promise<unknown>;
  // Used by CatalogRefreshService to invalidate every cached filter-combo
  // key (`conn:catalog:*`) after a successful full-refresh upsert. The
  // catalog cache namespace has low cardinality (bounded by distinct filter
  // combinations actually queried), so a KEYS scan is an acceptable,
  // simple choice here (not a general-purpose Redis pattern).
  keys(pattern: string): Promise<string[]>;
}
