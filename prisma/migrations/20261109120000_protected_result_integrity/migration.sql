-- Protected retained-result integrity (RI01–RI10). Additive only.
-- No backfill: existing protected settled rows keep NULL integrity columns
-- and are refused as integrity_unverified on replay.
--
-- Rollback contract:
--   ALTER TABLE "request_intent"
--     DROP COLUMN IF EXISTS "result_integrity_profile",
--     DROP COLUMN IF EXISTS "result_integrity_digest",
--     DROP COLUMN IF EXISTS "result_retention";

ALTER TABLE "request_intent"
  ADD COLUMN "result_integrity_profile" TEXT,
  ADD COLUMN "result_integrity_digest" TEXT,
  ADD COLUMN "result_retention" TEXT;
