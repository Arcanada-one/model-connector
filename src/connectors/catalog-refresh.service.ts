import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConnectorsService } from './connectors.service';
import {
  CatalogRepository,
  CatalogSnapshotConflictError,
  type ApplyProviderSnapshotInput,
  type ModelCatalogUpsert,
} from './catalog.repository';
import { entryToRow } from './catalog-mapper';
import { getConfig } from '../config/env.schema';
import { CATALOG_REDIS_CLIENT, type ICatalogRedis } from './catalog-redis.token';
import { ProviderAccessService, type ProviderAccessLike } from './provider-access.service';

// Defensive env reads evaluated at DECORATION time (class definition / import).
// @Cron/@Interval arguments run when the module is imported — before Nest
// bootstraps — so a bare getConfig() here would throw whenever the full env
// isn't validated yet (unit tests / CI `pnpm test` without DATABASE_URL) and
// break test collection. Fall back to the env.schema defaults; prod always has
// a validated config and reads the real values. (Matches the cascade-router
// try/catch convention.)
function catalogFullRefreshCron(): string {
  try {
    return getConfig().CATALOG_FULL_REFRESH_CRON;
  } catch {
    return '*/15 * * * *';
  }
}
function catalogStatusRefreshMs(): number {
  try {
    return getConfig().CATALOG_STATUS_REFRESH_MS;
  } catch {
    return 300_000;
  }
}

/**
 * CONN-0245 / CONN-0245-EXT — cron owner of the `model_catalog` (+
 * `provider_access` seeding) tables. This is the ONLY writer:
 * `ConnectorsService.getCatalog()` (the request path) only ever reads. Two
 * independent schedules:
 *
 *  - `fullRefresh` (default every 15m): best-effort live-model refresh per
 *    provider, rebuilds the full assembly via `buildCatalogSnapshot()` —
 *    which ALREADY applies CONN-0244's READ gate (a `read=false` provider's
 *    models never appear in the returned entries at all) and bakes
 *    `available` from the full `routable && executableHere && reachable &&
 *    !modelBreakerOpen` formula. This class only additionally persists
 *    CONN-0244's `access.use` per entry (`entryToRow`'s `routable` column,
 *    via `connectorsService.canUse`) so the read path can reconstruct the
 *    `access:read-only` tag. One provider failing never blanks the others'
 *    rows (Promise.allSettled inside `ConnectorsService.refreshAllProviderModels`,
 *    and this class's own try/catch around the whole cycle).
 *  - `statusRefresh` (default every 5m): lightweight per-connector
 *    `getStatus()` poll — flips `status`/`lastChecked` ONLY, never touches
 *    pricing/capabilities, so a transient outage doesn't null out a
 *    provider's last-known tariffs.
 *
 * `onModuleInit` seeds `ProviderAccess` defaults for every registered
 * connector (create-only — never overwrites an operator's existing DB
 * state), THEN fires one non-blocking `fullRefresh` so the table is warm
 * within seconds of boot instead of sitting empty until the first cron tick.
 */
@Injectable()
export class CatalogRefreshService implements OnModuleInit {
  private readonly logger = new Logger(CatalogRefreshService.name);
  private running = false;

  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly catalogRepo: CatalogRepository,
    @Inject(CATALOG_REDIS_CLIENT) private readonly catalogRedis: ICatalogRedis | null,
    @Inject(ProviderAccessService) private readonly providerAccess: ProviderAccessLike,
  ) {}

  async onModuleInit(): Promise<void> {
    // Seeding is a handful of cheap create-only DB upserts — worth awaiting
    // so the very first fullRefresh already sees correct READ/USE state.
    // fullRefresh itself stays fire-and-forget (it calls out to every live
    // provider and must not delay Nest's bootstrap sequence).
    try {
      await this.providerAccess.seedDefaults(this.connectorsService.listNames());
    } catch {
      this.logger.warn('seedDefaults failed on boot: reason=database');
    }
    void this.fullRefresh();
  }

  @Cron(catalogFullRefreshCron())
  async fullRefresh(): Promise<void> {
    if (this.running) {
      this.logger.warn('fullRefresh already in progress — skipping this overlapping tick');
      return;
    }
    this.running = true;
    try {
      const cycleObservedAt = new Date();
      // CONN-1672 / INFRA-0384 — last-known-good snapshot, captured BEFORE this
      // cycle writes anything, so the narrowing alarm below can compare the newly
      // assembled snapshot against what the DB is about to preserve. Best-effort:
      // a read failure just disables the alarm for this cycle (never blocks refresh).
      const lkgByConnector = new Map<string, number>();
      try {
        for (const row of await this.catalogRepo.findAll()) {
          lkgByConnector.set(row.connector, (lkgByConnector.get(row.connector) ?? 0) + 1);
        }
      } catch {
        this.logger.warn('narrowing-alarm baseline read failed: reason=database');
      }
      const refreshResults = await this.connectorsService.refreshAllProviderModels().catch(() => {
        this.logger.warn('refreshAllProviderModels failed: reason=unexpected');
        return new Map();
      });
      const entries = await this.connectorsService.buildCatalogSnapshot();
      const rowsByConnector = new Map<string, ModelCatalogUpsert[]>();
      for (const entry of entries) {
        // Defensive second READ check: buildCatalogSnapshot already filters
        // registered connectors, but persistence never trusts assembly alone.
        if (!this.connectorsService.canRead(entry.connector)) continue;
        const rows = rowsByConnector.get(entry.connector) ?? [];
        rows.push(
          entryToRow(entry, {
            useEnabled: this.connectorsService.canUse(entry.connector),
          }),
        );
        rowsByConnector.set(entry.connector, rows);
      }

      const registered = new Set(this.connectorsService.listNames());
      const dynamicProviders = new Set(this.connectorsService.listDynamicCatalogProviderNames());
      const providers = new Set([
        ...Array.from(registered).filter((name) => this.connectorsService.canRead(name)),
        ...rowsByConnector.keys(),
        ...refreshResults.keys(),
      ]);
      let persistedRows = 0;

      for (const connector of Array.from(providers).sort()) {
        if (!this.connectorsService.canRead(connector)) continue;
        const rows = rowsByConnector.get(connector) ?? [];
        const refresh = refreshResults.get(connector);

        if (refresh?.status === 'failed') {
          await this.catalogRepo.markProviderStale(connector, refresh.checkedAt);
          continue;
        }

        if (refresh?.status === 'success') {
          // A connector claiming successful enumeration but disappearing from
          // assembly is an integration gap, not proof that every model was
          // removed. Preserve LKG and defer.
          if (rows.length === 0) {
            await this.catalogRepo.markProviderStale(connector, refresh.observedAt);
            this.logger.warn(`catalog snapshot deferred for ${connector}: reason=assembly-gap`);
            continue;
          }
          persistedRows += await this.applyProviderSafely({
            connector,
            rows,
            source: 'provider-api',
            freshness: 'fresh',
            observedAt: refresh.observedAt,
            authoritative: true,
          });
          continue;
        }

        if (dynamicProviders.has(connector)) {
          // No explicit observation is not evidence that buildCatalogSnapshot's
          // current in-memory rows are the immutable static floor. They may be
          // last-known dynamic cache. Preserve DB truth and defer.
          await this.catalogRepo.markProviderStale(connector, cycleObservedAt);
          this.logger.warn(
            `catalog snapshot deferred for ${connector}: reason=missing-observation`,
          );
          continue;
        }

        if (rows.length === 0) continue;
        persistedRows += await this.applyProviderSafely({
          connector,
          rows,
          source: registered.has(connector) ? 'static-capabilities' : 'static-modality-catalog',
          freshness: 'static',
          observedAt: cycleObservedAt,
          authoritative: true,
        });
      }

      // CONN-1672 / INFRA-0384 — narrowing alarm. The LKG-preservation above
      // (QA-FIX-A) deliberately keeps a provider's last-known-good rows when a
      // cycle assembles nothing for it — a genuine safety, but one that also HIDES
      // a silent narrowing (a readable provider suddenly assembling zero rows, or
      // the whole catalog shrinking hard between cycles). "Silence must never look
      // like health": diagnose it LOUDLY. This is pure observability layered on top
      // — it does NOT change the preservation behavior above. Compared over the set
      // of currently-readable providers only, so an operator READ toggle (a
      // deliberate hide) never trips a false alarm.
      let assembledTotal = 0;
      for (const rows of rowsByConnector.values()) assembledTotal += rows.length;
      let lkgReadableTotal = 0;
      for (const [connector, lkgCount] of lkgByConnector) {
        if (!this.connectorsService.canRead(connector)) continue;
        lkgReadableTotal += lkgCount;
        if (lkgCount > 0 && (rowsByConnector.get(connector)?.length ?? 0) === 0) {
          this.logger.warn(
            `catalog narrowing alarm: ${connector} assembled 0 rows this cycle but ` +
              `last-known-good held ${lkgCount} (rows preserved via LKG — investigate: silent narrowing)`,
          );
        }
      }
      if (lkgReadableTotal > 0 && assembledTotal < lkgReadableTotal * 0.8) {
        this.logger.warn(
          `catalog narrowing alarm: assembled ${assembledTotal} rows this cycle vs ` +
            `last-known-good ${lkgReadableTotal} (>20% shrink across readable providers — investigate)`,
        );
      }

      // Pick up any operator-side DB toggle made directly in provider_access
      // since the last cycle, and invalidate the short-TTL catalog cache.
      await this.providerAccess.refresh();
      await this.invalidateCatalogCache();
      this.logger.log(`fullRefresh persisted ${persistedRows} model_catalog rows`);
    } catch {
      this.logger.error('fullRefresh cycle failed: reason=unexpected');
    } finally {
      this.running = false;
    }
  }

  @Interval(catalogStatusRefreshMs())
  async statusRefresh(): Promise<void> {
    const names = this.connectorsService.listNames();
    await Promise.allSettled(
      names.map(async (name) => {
        const lastChecked = new Date();
        try {
          const status = await this.connectorsService.getStatus(name);
          await this.catalogRepo.updateProviderStatus(
            name,
            status.healthy ? 'online' : 'offline',
            lastChecked,
          );
        } catch {
          this.logger.warn(`getStatus failed for ${name}: reason=provider`);
          await this.catalogRepo.updateProviderStatus(name, 'offline', lastChecked);
        }
      }),
    );
  }

  private async invalidateCatalogCache(): Promise<void> {
    if (!this.catalogRedis) return;
    try {
      const keys = await this.catalogRedis.keys('conn:catalog:*');
      await Promise.all(keys.map((key) => this.catalogRedis!.del(key)));
    } catch {
      // Non-fatal — the short cache TTL (CATALOG_CACHE_TTL_MS, default 30s)
      // self-heals staleness even if invalidation fails.
      this.logger.warn('Catalog cache invalidation failed: reason=cache');
    }
  }

  private async applyProviderSafely(input: ApplyProviderSnapshotInput): Promise<number> {
    try {
      const applied = await this.catalogRepo.applyProviderSnapshot(input);
      return applied.rowCount;
    } catch (error) {
      if (error instanceof CatalogSnapshotConflictError) {
        this.logger.warn(`catalog snapshot deferred for ${input.connector}: code=${error.code}`);
      } else {
        this.logger.warn(`catalog snapshot deferred for ${input.connector}: reason=database`);
      }
      return 0;
    }
  }
}
