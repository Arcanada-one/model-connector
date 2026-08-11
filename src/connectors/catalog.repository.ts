import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  diffCatalogRows,
  fingerprintProviderSnapshot,
  prepareCatalogRows,
  type PreviousCatalogRow,
} from './catalog-snapshot';

export type CatalogSource =
  | 'provider-api'
  | 'static-capabilities'
  | 'static-modality-catalog'
  | 'legacy-unknown';

export type CatalogFreshness = 'fresh' | 'stale' | 'static' | 'unknown';

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
  snapshotId: string | null;
  contentFingerprint: string | null;
  observedAt: Date;
  source: CatalogSource;
  freshness: CatalogFreshness;
  absentSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface ApplyProviderSnapshotInput {
  connector: string;
  rows: ModelCatalogUpsert[];
  source: Exclude<CatalogSource, 'legacy-unknown'>;
  freshness: Extract<CatalogFreshness, 'fresh' | 'static'>;
  observedAt: Date;
  authoritative: boolean;
}

export interface AppliedCatalogSnapshot {
  snapshotId: string;
  fingerprint: string;
  rowCount: number;
}

export class CatalogSnapshotConflictError extends Error {
  readonly code = 'CATALOG_SNAPSHOT_CONFLICT';

  constructor() {
    super('Catalog snapshot conflict; retry on the next refresh cycle');
    this.name = 'CatalogSnapshotConflictError';
  }
}

export class CatalogSnapshotValidationError extends Error {
  readonly code = 'CATALOG_SNAPSHOT_INVALID_INPUT';

  constructor() {
    super('Catalog snapshot input is invalid');
    this.name = 'CatalogSnapshotValidationError';
  }
}

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
   * Apply one provider observation atomically. The before-state read,
   * fingerprinted snapshot identity, row mutations, provider-only tombstones,
   * and drift events share one serializable view.
   *
   * Prisma P2034 write conflicts retry the complete transaction, never a
   * partial step. Exhaustion surfaces a sanitized domain error so callers can
   * defer this provider without leaking database details.
   */
  async applyProviderSnapshot(input: ApplyProviderSnapshotInput): Promise<AppliedCatalogSnapshot> {
    this.validateProviderSnapshotInput(input);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.applyProviderSnapshotTransaction(input);
      } catch (error) {
        if (!this.isSerializableConflict(error)) {
          throw error;
        }
        if (attempt === 3) {
          throw new CatalogSnapshotConflictError();
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 5));
      }
    }
    throw new CatalogSnapshotConflictError();
  }

  async markProviderStale(connector: string, checkedAt: Date): Promise<number> {
    const result = await this.prisma.modelCatalog.updateMany({
      where: { connector, absent: false },
      data: { freshness: 'stale', lastChecked: checkedAt },
    });
    return result.count;
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

  private async applyProviderSnapshotTransaction(
    input: ApplyProviderSnapshotInput,
  ): Promise<AppliedCatalogSnapshot> {
    return this.prisma.$transaction(
      async (tx) => {
        const previousRows = (await tx.modelCatalog.findMany({
          where: { connector: input.connector },
        })) as PreviousCatalogRow[];
        const preparedRows = prepareCatalogRows(input.rows);
        const fingerprint = fingerprintProviderSnapshot(input.connector, preparedRows);
        const snapshot = await tx.catalogSnapshot.create({
          data: {
            connector: input.connector,
            fingerprint,
            source: input.source,
            observedAt: input.observedAt,
            freshness: input.freshness,
            authoritative: input.authoritative,
            rowCount: preparedRows.length,
          },
        });
        const drift = input.authoritative ? diffCatalogRows(previousRows, preparedRows) : [];
        const previousModels = new Set(previousRows.map((row) => row.model));

        for (const prepared of preparedRows) {
          // A static boot floor is evidence only for previously unknown rows.
          // It must never overwrite or resurrect authoritative historical
          // state (especially an already-absent row) after a dynamic failure.
          if (!input.authoritative && previousModels.has(prepared.row.model)) {
            continue;
          }
          const persistence = {
            ...prepared.row,
            snapshotId: snapshot.id,
            contentFingerprint: prepared.contentFingerprint,
            observedAt: input.observedAt,
            source: input.source,
            freshness: input.freshness,
            lastSeen: input.observedAt,
            absent: false,
            absentSince: null,
          };
          await tx.modelCatalog.upsert({
            where: {
              connector_model: {
                connector: input.connector,
                model: prepared.row.model,
              },
            },
            create: {
              ...persistence,
              firstSeen: input.observedAt,
            },
            update: persistence,
          });
        }

        if (input.authoritative) {
          await tx.modelCatalog.updateMany({
            where: {
              connector: input.connector,
              absent: false,
              model: { notIn: preparedRows.map(({ row }) => row.model) },
            },
            data: {
              absent: true,
              absentSince: input.observedAt,
              snapshotId: snapshot.id,
            },
          });

          if (drift.length > 0) {
            await tx.catalogDriftEvent.createMany({
              data: drift.map((event) => ({
                snapshotId: snapshot.id,
                connector: input.connector,
                model: event.model,
                changeType: event.changeType,
                beforeFingerprint: event.beforeFingerprint,
                afterFingerprint: event.afterFingerprint,
                changedFields: event.changedFields,
                observedAt: input.observedAt,
              })),
            });
          }
        }

        return {
          snapshotId: snapshot.id,
          fingerprint,
          rowCount: preparedRows.length,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private isSerializableConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2034'
    );
  }

  private validateProviderSnapshotInput(input: ApplyProviderSnapshotInput): void {
    const models = new Set<string>();
    for (const row of input.rows) {
      if (row.connector !== input.connector || models.has(row.model)) {
        throw new CatalogSnapshotValidationError();
      }
      models.add(row.model);
    }
  }
}
