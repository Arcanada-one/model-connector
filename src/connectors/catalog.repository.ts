import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// CONN-0245 — DB-as-source-of-truth model catalog. Write shape used by the
// cron (CatalogRefreshService) when persisting a snapshot row. Deliberately
// excludes `id`/`firstSeen`/`lastSeen`/`absent`/`createdAt`/`updatedAt` — those
// are repository-owned bookkeeping fields, never set by the caller.
export interface ModelCatalogUpsert {
  connector: string;
  model: string;
  modality: string;
  status: 'online' | 'offline';
  lastChecked: Date;
  supportsStreaming: boolean;
  supportsJsonSchema: boolean;
  supportsTools: boolean;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  priceUnit: string;
  tier: 'free' | 'paid' | 'unknown';
  free: boolean;
  // QA FIX B (Finding 1) — legacy MC-side price multiplier (0 = free;
  // 1 = standard; null = unknown; OPENMODEL_CATALOGUE-sourced). NOT
  // consulted for tier/free (see catalog-mapper.ts deriveTier) — persisted
  // verbatim so the external site's `priceMultiplier`/`cheap` fields survive
  // the DB round-trip unchanged instead of being fabricated on read.
  priceMultiplier: number | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  endpoint: string | null;
  executableHere: boolean;
  // CONN-0244 — per-provider USE access (`ProviderAccess.use`), persisted
  // verbatim so the read path can reconstruct the `access:read-only` tag.
  // NOT a compound of useEnabled && executableHere — availability for
  // routing is derived separately (see `available`, computed from `status`
  // at persist time in catalog-mapper.ts's entryToRow/rowToEntry).
  routable: boolean;
}

// Read shape — full persisted row, as returned by `findAll()` for the
// getCatalog() read path.
export type ModelCatalogRow = ModelCatalogUpsert & {
  id: string;
  firstSeen: Date;
  lastSeen: Date;
  absent: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Narrow structural interface — the only method `ConnectorsService.getCatalog()`
 * needs. Lets specs inject a `{ findAll: vi.fn() }` mock without depending on
 * the concrete Prisma-backed class.
 */
export interface CatalogRepositoryLike {
  findAll(): Promise<ModelCatalogRow[]>;
}

/**
 * CONN-0245 — thin Prisma wrapper around the `model_catalog` table. The ONLY
 * writer is CatalogRefreshService (cron); the ONLY reader on the request path
 * is ConnectorsService.getCatalog(). No provider I/O happens here — this is a
 * pure persistence boundary.
 */
@Injectable()
export class CatalogRepository implements CatalogRepositoryLike {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a full snapshot of rows by (connector, model). `firstSeen` is set
   * only in the `create` branch — an existing row's `firstSeen` is therefore
   * never overwritten by a later refresh cycle. `lastSeen` and `absent:false`
   * are refreshed on every upsert (create AND update) since a row upserted
   * this cycle was, by definition, just seen.
   */
  async upsertSnapshot(rows: ModelCatalogUpsert[]): Promise<void> {
    const now = new Date();
    for (const row of rows) {
      await this.prisma.modelCatalog.upsert({
        where: { connector_model: { connector: row.connector, model: row.model } },
        create: { ...row, firstSeen: now, lastSeen: now, absent: false },
        update: { ...row, lastSeen: now, absent: false },
      });
    }
  }

  /**
   * Flip `absent=true` for every non-absent row whose (connector, model) is
   * NOT in `seen` this cycle. Rows are NEVER deleted — a model that
   * disappears from a provider's live list keeps its last-known pricing/caps
   * for history/audit, it is just excluded from `findAll()` (the live read
   * path) going forward.
   */
  async markAbsentExcept(seen: Array<{ connector: string; model: string }>): Promise<void> {
    if (seen.length === 0) {
      // Nothing seen this cycle at all (e.g. every provider failed) — mark
      // everything currently live as absent rather than leaving stale
      // "online" rows with no corresponding snapshot entry.
      await this.prisma.modelCatalog.updateMany({
        where: { absent: false },
        data: { absent: true },
      });
      return;
    }
    await this.prisma.modelCatalog.updateMany({
      where: {
        absent: false,
        NOT: { OR: seen.map((s) => ({ connector: s.connector, model: s.model })) },
      },
      data: { absent: true },
    });
  }

  /**
   * Status-only refresh — touches ONLY `status` + `lastChecked` for every row
   * of `connector`. Never touches pricing/caps, so a provider outage does not
   * blank out its last-known tariffs/capabilities.
   */
  async updateProviderStatus(
    connector: string,
    status: 'online' | 'offline',
    lastChecked: Date,
  ): Promise<void> {
    await this.prisma.modelCatalog.updateMany({
      where: { connector },
      data: { status, lastChecked },
    });
  }

  /**
   * All non-absent rows — the live catalog read path. Filtering by
   * modality/free/capability/etc. happens in the service layer
   * (`entryMatchesFilters`) so semantics stay identical to the pre-CONN-0245
   * assembly-time filtering.
   */
  async findAll(): Promise<ModelCatalogRow[]> {
    return this.prisma.modelCatalog.findMany({ where: { absent: false } }) as Promise<
      ModelCatalogRow[]
    >;
  }
}
