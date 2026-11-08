-- Protected Lab reservation lifecycle (stage A). Additive only.
-- Old request_intent rows keep held/released/expired/completed semantics via
-- lifecycle_version = 0 and NULL protected_phase.

ALTER TABLE "request_intent"
  ADD COLUMN "lifecycle_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "protected_phase" TEXT,
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reservation_ref" TEXT,
  ADD COLUMN "operation_key" TEXT,
  ADD COLUMN "provider_name" TEXT,
  ADD COLUMN "model_name" TEXT,
  ADD COLUMN "route_key" TEXT,
  ADD COLUMN "price_policy_revision" TEXT,
  ADD COLUMN "amount_unit" TEXT,
  ADD COLUMN "amount_precision" INTEGER;

CREATE UNIQUE INDEX "request_intent_reservation_ref_key"
  ON "request_intent"("reservation_ref");

CREATE INDEX "request_intent_protected_phase_expires_at_idx"
  ON "request_intent"("protected_phase", "expires_at");
