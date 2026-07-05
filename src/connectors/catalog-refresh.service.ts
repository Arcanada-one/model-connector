import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConnectorsService } from './connectors.service';
import { CatalogRepository } from './catalog.repository';
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
    } catch (err) {
      this.logger.warn(
        `seedDefaults failed on boot (continuing with existing access state): ${err}`,
      );
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
      // Best-effort: refreshModels() (per BaseApiConnector) never throws and
      // refreshAllProviderModels() additionally allSettled's across
      // connectors, but we still guard the whole cycle below so a totally
      // unexpected rejection can't skip the persist step.
      await this.connectorsService.refreshAllProviderModels().catch((err) => {
        this.logger.warn(`refreshAllProviderModels failed (continuing with cached models): ${err}`);
      });

      // CONN-0244's READ gate already ran inside buildCatalogSnapshot() — a
      // `read=false` provider's models are simply absent from `entries`.
      // markAbsentExcept below will then flag any of its prior rows absent
      // (hidden from the live catalog) since they're no longer in `rows`.
      const entries = await this.connectorsService.buildCatalogSnapshot();
      const rows = entries.map((entry) =>
        entryToRow(entry, { useEnabled: this.connectorsService.canUse(entry.connector) }),
      );

      // QA FIX A (Finding 2, prod catalog-wipe) — an EMPTY assembly (every
      // provider transiently unreachable, or every provider currently
      // read=false) must NOT be treated as "nothing is live anymore". Calling
      // markAbsentExcept([]) here would flag EVERY existing row absent,
      // blanking the live catalog on a single bad cycle. Skip the persist
      // step entirely and keep last-known-good rows — the next cycle (or
      // statusRefresh) will recover once a provider is reachable/readable
      // again.
      if (rows.length === 0) {
        this.logger.warn(
          'fullRefresh: empty catalog snapshot — keeping last-known rows, skipping upsert/markAbsent this cycle',
        );
        return;
      }

      await this.catalogRepo.upsertSnapshot(rows);
      await this.catalogRepo.markAbsentExcept(
        rows.map((r) => ({ connector: r.connector, model: r.model })),
      );

      // Pick up any operator-side DB toggle made directly in provider_access
      // since the last cycle, and invalidate the short-TTL catalog cache.
      await this.providerAccess.refresh();
      await this.invalidateCatalogCache();
      this.logger.log(`fullRefresh persisted ${rows.length} model_catalog rows`);
    } catch (err) {
      this.logger.error(`fullRefresh cycle failed: ${err}`);
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
        } catch (err) {
          this.logger.warn(`getStatus failed for ${name} — marking offline: ${err}`);
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
    } catch (err) {
      // Non-fatal — the short cache TTL (CATALOG_CACHE_TTL_MS, default 30s)
      // self-heals staleness even if invalidation fails.
      this.logger.warn(`Catalog cache invalidation failed (non-fatal): ${err}`);
    }
  }
}
