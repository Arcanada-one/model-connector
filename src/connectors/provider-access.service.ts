import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getConfig } from '../config/env.schema';
import { parseProviderAccess, resolveProviderAccess, type ProviderAccess } from './provider-access';

// Debounce window for `refresh()` — avoids hammering Postgres if it's called
// more often than this (e.g. once per fullRefresh tick). Not a correctness
// mechanism (getAccess() never blocks on it): `force: true` always bypasses
// it (used right after seedDefaults()).
const REFRESH_DEBOUNCE_MS = 60_000;

/**
 * Narrow structural interface — the surface `ConnectorsService.getAccess()`
 * and `CatalogRefreshService` actually depend on. Lets specs inject a
 * hand-rolled mock without depending on the concrete Prisma-backed class.
 */
export interface ProviderAccessLike {
  seedDefaults(providerNames: string[]): Promise<void>;
  refresh(force?: boolean): Promise<void>;
  getAccess(name: string): ProviderAccess;
}

/**
 * CONN-0245-EXT — DB-backed RUNTIME STATE for CONN-0244's per-provider
 * READ/USE access model. Reconciles the two:
 *
 *   - CONN-0244 (`provider-access.ts`, `PROVIDER_ACCESS` env) is the shipped,
 *     deployed CONFIG contract — it is both the operator-facing seed source
 *     AND the fallback when the DB has no row for a provider yet.
 *   - This service is the DB (`provider_access` table) — the AUTHORITATIVE
 *     runtime state once seeded. An operator's direct DB-side toggle is
 *     never overwritten by a later config change or restart.
 *
 * `getAccess()` is deliberately SYNCHRONOUS (reads an in-memory cache
 * populated by the async `seedDefaults()`/`refresh()`) so that
 * `ConnectorsService.getAccess()` — called from hot, synchronous code paths
 * (the catalog assembly loop, `execute()`'s pre-flight gate, the cascade
 * candidate filter) — never has to become async itself. Before the cache is
 * ever populated (fresh boot, before the cron's first `onModuleInit` seed
 * completes), `getAccess()` falls through to the exact CONN-0244 config
 * computation — i.e. behavior is byte-identical to pre-CONN-0245-EXT until
 * the DB layer is seeded, and per-provider once seeded.
 */
@Injectable()
export class ProviderAccessService implements ProviderAccessLike {
  private readonly logger = new Logger(ProviderAccessService.name);
  private cache: Map<string, ProviderAccess> | null = null;
  private cachedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  private currentConfigCsv(): string {
    try {
      return getConfig().PROVIDER_ACCESS;
    } catch {
      // Env not validated yet (e.g. early boot / test context) — fall back
      // to the documented CONN-0244 default rather than throwing.
      return 'openmodel:read';
    }
  }

  private configAccess(name: string): ProviderAccess {
    return resolveProviderAccess(parseProviderAccess(this.currentConfigCsv()), name);
  }

  /**
   * Create-only seed: for every provider in `providerNames` (registered
   * connectors) UNION every provider named in the `PROVIDER_ACCESS` config
   * (so an operator can pre-configure access for a provider before it's even
   * registered), insert the default row derived from CONN-0244's config
   * resolution. NEVER overwrites an existing row — once seeded, the DB is
   * authoritative (an operator's DB-side toggle survives restarts and
   * config changes). Ends by force-reloading the sync cache so the very
   * next `getAccess()` call already reflects the seeded state.
   */
  async seedDefaults(providerNames: string[]): Promise<void> {
    const parsed = parseProviderAccess(this.currentConfigCsv());
    const allNames = new Set([...providerNames, ...parsed.keys()]);

    for (const name of allNames) {
      const existing = await this.prisma.providerAccess.findUnique({ where: { provider: name } });
      if (existing) continue;
      const access = resolveProviderAccess(parsed, name);
      try {
        await this.prisma.providerAccess.create({
          data: { provider: name, readEnabled: access.read, useEnabled: access.use },
        });
      } catch (err) {
        // Benign race (two boots seeding concurrently) — another process
        // already created the row; DB state wins either way.
        this.logger.warn(`seedDefaults: create failed for "${name}" (non-fatal): ${err}`);
      }
    }
    await this.refresh(true);
  }

  /**
   * Reload the in-memory cache from `provider_access`. Debounced to
   * `REFRESH_DEBOUNCE_MS` unless `force` — the cron calls this once per
   * cycle, and `seedDefaults()` always forces a reload right after seeding.
   */
  async refresh(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.cache && now - this.cachedAt < REFRESH_DEBOUNCE_MS) {
      return;
    }
    const rows = await this.prisma.providerAccess.findMany();
    const map = new Map<string, ProviderAccess>();
    for (const row of rows) {
      map.set(row.provider, { read: row.readEnabled, use: row.useEnabled });
    }
    this.cache = map;
    this.cachedAt = now;
  }

  /**
   * DB row if the cache has one for `name`; else the CONN-0244 config
   * default (which itself falls back to `DEFAULT_PROVIDER_ACCESS` — fully
   * enabled — for a provider named in neither).
   */
  getAccess(name: string): ProviderAccess {
    const cached = this.cache?.get(name);
    if (cached) return cached;
    return this.configAccess(name);
  }
}
