-- CONN-1665 — per-key access policy (nullable JSONB; shape governed by the Zod
-- schema in src/policy/policy.schema.ts, validated at write time in the admin API).
ALTER TABLE "ApiKey" ADD COLUMN "policy" JSONB;
