import { createHash } from 'node:crypto';
import type { ModelCatalogUpsert } from './catalog.repository';

export type CatalogStableContent = {
  connector: string;
  model: string;
  modality: string;
  supportsStreaming: boolean;
  supportsJsonSchema: boolean;
  supportsTools: boolean;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  priceUnit: string;
  tier: 'free' | 'paid' | 'unknown';
  free: boolean;
  priceMultiplier: number | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  endpoint: string | null;
  executableHere: boolean;
};

export type PreparedCatalogRow = {
  row: ModelCatalogUpsert;
  stableContent: CatalogStableContent;
  contentFingerprint: string;
};

export type PreviousCatalogRow = ModelCatalogUpsert & {
  absent: boolean;
  contentFingerprint: string | null;
};

export type CatalogDrift = {
  model: string;
  changeType: 'added' | 'removed' | 'changed';
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  changedFields: string[];
};

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function catalogStableContent(row: ModelCatalogUpsert): CatalogStableContent {
  return {
    connector: row.connector,
    model: row.model,
    modality: row.modality,
    supportsStreaming: row.supportsStreaming,
    supportsJsonSchema: row.supportsJsonSchema,
    supportsTools: row.supportsTools,
    inputPerMTok: row.inputPerMTok,
    outputPerMTok: row.outputPerMTok,
    priceUnit: row.priceUnit,
    tier: row.tier,
    free: row.free,
    priceMultiplier: row.priceMultiplier,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    endpoint: row.endpoint,
    executableHere: row.executableHere,
  };
}

export function fingerprintCatalogRow(row: ModelCatalogUpsert): string {
  return sha256(catalogStableContent(row));
}

export function prepareCatalogRows(rows: ModelCatalogUpsert[]): PreparedCatalogRow[] {
  return rows.map((row) => {
    const stableContent = catalogStableContent(row);
    return {
      row,
      stableContent,
      contentFingerprint: sha256(stableContent),
    };
  });
}

export function fingerprintProviderSnapshot(connector: string, rows: PreparedCatalogRow[]): string {
  return sha256({
    connector,
    models: rows
      .map(({ row, contentFingerprint }) => ({ model: row.model, fingerprint: contentFingerprint }))
      .sort((a, b) => a.model.localeCompare(b.model)),
  });
}

function changedFieldNames(before: CatalogStableContent, after: CatalogStableContent): string[] {
  return (Object.keys(after) as Array<keyof CatalogStableContent>)
    .filter((field) => before[field] !== after[field])
    .sort();
}

export function diffCatalogRows(
  previousRows: PreviousCatalogRow[],
  nextRows: PreparedCatalogRow[],
): CatalogDrift[] {
  const previousByModel = new Map(previousRows.map((row) => [row.model, row]));
  const nextByModel = new Map(nextRows.map((prepared) => [prepared.row.model, prepared]));
  const drift: CatalogDrift[] = [];

  for (const prepared of nextRows) {
    const previous = previousByModel.get(prepared.row.model);
    if (!previous || previous.absent) {
      drift.push({
        model: prepared.row.model,
        changeType: 'added',
        beforeFingerprint: previous?.contentFingerprint ?? null,
        afterFingerprint: prepared.contentFingerprint,
        changedFields: [],
      });
      continue;
    }

    if (
      previous.contentFingerprint !== null &&
      previous.contentFingerprint !== prepared.contentFingerprint
    ) {
      drift.push({
        model: prepared.row.model,
        changeType: 'changed',
        beforeFingerprint: previous.contentFingerprint,
        afterFingerprint: prepared.contentFingerprint,
        changedFields: changedFieldNames(catalogStableContent(previous), prepared.stableContent),
      });
    }
  }

  for (const previous of previousRows) {
    if (!previous.absent && !nextByModel.has(previous.model)) {
      drift.push({
        model: previous.model,
        changeType: 'removed',
        beforeFingerprint: previous.contentFingerprint,
        afterFingerprint: null,
        changedFields: [],
      });
    }
  }

  return drift.sort((a, b) => a.model.localeCompare(b.model));
}
