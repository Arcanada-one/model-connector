-- CONN-0104 — STT Phase 2 async pipeline audit delta.
-- Adds mode + jobId columns to SttTranscription. Additive only:
--   * mode NOT NULL DEFAULT 'sync' — existing rows backfill to 'sync' (no
--     data movement; old sync path remains source-of-truth).
--   * jobId TEXT NULL UNIQUE — only populated for mode='async' rows; UNIQUE
--     index lets the polling GET /v1/speech/stt/jobs/:id lookup land on the
--     index without sequential scan.
-- Rollback-safe: drop columns reverses without data loss (sync path does
-- not read mode/jobId).

ALTER TABLE "SttTranscription"
    ADD COLUMN "mode"  TEXT NOT NULL DEFAULT 'sync',
    ADD COLUMN "jobId" TEXT;

CREATE UNIQUE INDEX "SttTranscription_jobId_key" ON "SttTranscription"("jobId");
