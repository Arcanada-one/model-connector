-- CONN-1646: provider-scoped catalog snapshots, provenance, and drift.
-- Additive only. Historical identities and fingerprints are intentionally not
-- invented for rows that predate this migration.

CREATE TABLE "catalog_snapshots" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "freshness" TEXT NOT NULL,
    "authoritative" BOOLEAN NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_snapshots_source_check"
      CHECK ("source" IN ('provider-api', 'static-capabilities', 'static-modality-catalog')),
    CONSTRAINT "catalog_snapshots_freshness_check"
      CHECK ("freshness" IN ('fresh', 'stale', 'static', 'unknown'))
);

CREATE TABLE "catalog_drift_events" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "beforeFingerprint" TEXT,
    "afterFingerprint" TEXT,
    "changedFields" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_drift_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_drift_events_changeType_check"
      CHECK ("changeType" IN ('added', 'removed', 'changed'))
);

ALTER TABLE "model_catalog"
  ADD COLUMN "snapshotId" TEXT,
  ADD COLUMN "contentFingerprint" TEXT,
  ADD COLUMN "observedAt" TIMESTAMP(3),
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'legacy-unknown',
  ADD COLUMN "freshness" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "absentSince" TIMESTAMP(3);

UPDATE "model_catalog"
SET "observedAt" = "lastSeen",
    "source" = 'legacy-unknown',
    "freshness" = 'unknown';

ALTER TABLE "model_catalog"
  ALTER COLUMN "observedAt" SET NOT NULL,
  ADD CONSTRAINT "model_catalog_source_check"
    CHECK ("source" IN (
      'provider-api',
      'static-capabilities',
      'static-modality-catalog',
      'legacy-unknown'
    )),
  ADD CONSTRAINT "model_catalog_freshness_check"
    CHECK ("freshness" IN ('fresh', 'stale', 'static', 'unknown'));

CREATE INDEX "catalog_snapshots_connector_observedAt_idx"
  ON "catalog_snapshots"("connector", "observedAt");
CREATE INDEX "catalog_drift_events_connector_observedAt_idx"
  ON "catalog_drift_events"("connector", "observedAt");
CREATE INDEX "catalog_drift_events_snapshotId_idx"
  ON "catalog_drift_events"("snapshotId");
CREATE INDEX "model_catalog_snapshotId_idx"
  ON "model_catalog"("snapshotId");

ALTER TABLE "model_catalog"
  ADD CONSTRAINT "model_catalog_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "catalog_snapshots"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "catalog_drift_events"
  ADD CONSTRAINT "catalog_drift_events_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "catalog_snapshots"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
