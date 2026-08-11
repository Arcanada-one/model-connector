import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'prisma/migrations/20260726150000_conn_1646_catalog_snapshots/migration.sql',
);

describe('CONN-1646 catalog snapshot migration', () => {
  it('defines the additive snapshot, drift, and provenance schema', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const migration = readFileSync(migrationPath, 'utf8');

    expect(schema).toContain('model CatalogSnapshot');
    expect(schema).toContain('model CatalogDriftEvent');
    for (const field of [
      'snapshotId',
      'contentFingerprint',
      'observedAt',
      'source',
      'freshness',
      'absentSince',
    ]) {
      expect(schema).toMatch(new RegExp(`\\b${field}\\b`));
    }

    expect(migration).toContain('CREATE TABLE "catalog_snapshots"');
    expect(migration).toContain('CREATE TABLE "catalog_drift_events"');
    expect(migration).toContain('model_catalog_snapshotId_fkey');
    expect(migration).toContain('catalog_drift_events_snapshotId_fkey');
    expect(migration).toContain('model_catalog_source_check');
    expect(migration).toContain('model_catalog_freshness_check');
    expect(migration).toContain('catalog_drift_events_changeType_check');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
  });

  it('backfills only machine-recorded legacy provenance without fabricating identity', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toMatch(
      /UPDATE "model_catalog"\s+SET "observedAt" = "lastSeen",\s+"source" = 'legacy-unknown',\s+"freshness" = 'unknown'/s,
    );
    expect(migration).not.toMatch(
      /UPDATE "model_catalog"[\s\S]*SET[\s\S]*"(?:snapshotId|contentFingerprint|absentSince)"\s*=/i,
    );
  });
});
