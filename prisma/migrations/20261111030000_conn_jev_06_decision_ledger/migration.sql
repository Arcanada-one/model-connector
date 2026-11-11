-- CONN-JEV-06 — DecisionLedger/v1 append-only storage for typesafe-jev decisions.
-- Digests of input (state), template and route form identity_digest (unique).
-- UPDATE/DELETE are refused so the ledger cannot be rewritten in place.

CREATE TABLE "decision_ledger" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'DecisionLedger/v1',
    "identity_digest" TEXT NOT NULL,
    "decision_type" TEXT NOT NULL,
    "template_ref" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "model_requested" TEXT NOT NULL,
    "model_observed" TEXT,
    "provider_request_id" TEXT,
    "state_digest" TEXT NOT NULL,
    "template_digest" TEXT NOT NULL,
    "route_digest" TEXT NOT NULL,
    "candidate_set_digest" TEXT,
    "answers" JSONB NOT NULL,
    "verdict" TEXT NOT NULL,
    "policy_action" TEXT NOT NULL,
    "suppressed_permissive" BOOLEAN NOT NULL,
    "abstained" BOOLEAN NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "usage_missing" BOOLEAN NOT NULL,
    "cost_usd" DECIMAL(10,6),
    "cache_hit" TEXT NOT NULL,
    "trace_id" TEXT,
    "caller" TEXT,
    "state_lang" TEXT NOT NULL,
    "outcome" TEXT,
    "request_id" TEXT,
    "api_key_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "decision_ledger_identity_digest_key" ON "decision_ledger"("identity_digest");
CREATE UNIQUE INDEX "decision_ledger_request_id_key" ON "decision_ledger"("request_id");
CREATE INDEX "decision_ledger_api_key_id_created_at_idx" ON "decision_ledger"("api_key_id", "created_at");
CREATE INDEX "decision_ledger_route_created_at_idx" ON "decision_ledger"("route", "created_at");
CREATE INDEX "decision_ledger_decision_type_created_at_idx" ON "decision_ledger"("decision_type", "created_at");

ALTER TABLE "decision_ledger"
  ADD CONSTRAINT "decision_ledger_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "Request"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "decision_ledger"
  ADD CONSTRAINT "decision_ledger_api_key_id_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES "ApiKey"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "decision_ledger"
  ADD CONSTRAINT "decision_ledger_version_check"
  CHECK ("version" = 'DecisionLedger/v1');

ALTER TABLE "decision_ledger"
  ADD CONSTRAINT "decision_ledger_state_lang_check"
  CHECK ("state_lang" IN ('en', 'ru', 'mixed'));

ALTER TABLE "decision_ledger"
  ADD CONSTRAINT "decision_ledger_latency_nonnegative"
  CHECK ("latency_ms" >= 0);

-- AC-15 class: cost_usd = 0 is forbidden when usage is missing (no machine meter).
-- Unpriced settles must store NULL, never a fabricated zero.
ALTER TABLE "decision_ledger"
  ADD CONSTRAINT "decision_ledger_cost_usd_usage_missing"
  CHECK (NOT ("usage_missing" = TRUE AND "cost_usd" IS NOT NULL AND "cost_usd" = 0));

CREATE OR REPLACE FUNCTION "enforce_decision_ledger_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'DecisionLedger/v1 rows are append-only';
END;
$$;

CREATE TRIGGER "decision_ledger_append_only"
BEFORE UPDATE OR DELETE ON "decision_ledger"
FOR EACH ROW
EXECUTE FUNCTION "enforce_decision_ledger_append_only"();
