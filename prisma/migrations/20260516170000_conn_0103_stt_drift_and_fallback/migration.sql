-- CONN-0103 — STT Phase 1b audit delta.
-- Adds fallbackCount + driftStatus columns to SttTranscription.
-- Forward-compatible: both columns nullable / defaulted, no backfill required.

ALTER TABLE "SttTranscription"
    ADD COLUMN "fallbackCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "driftStatus"   TEXT;
