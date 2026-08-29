-- ARAS-0058 — make the ledger survive real money.
--
-- Three things land together because they are one invariant, not three:
-- a floor the database enforces, a place to hold funds while a request is in
-- flight, and a per-intent identity so a replay is not a second charge.

-- ---------------------------------------------------------------------------
-- 1. Refuse to proceed on data that already violates the floor.
--
-- `ALTER TABLE ... ADD CONSTRAINT ... CHECK` would fail on its own here, but it
-- fails with `check constraint "..." of relation "credits_balance" is violated
-- by some row` and names no row. Whoever is watching a production deploy at
-- that moment needs to know WHICH accounts and by how much, because the answer
-- decides whether the fix is a top-up or a rollback. So we look first and say
-- so.
--
-- This is deliberately fatal rather than self-healing. A negative balance means
-- money was lent that the gate was supposed to prevent; zeroing it silently
-- would destroy the only evidence of how much and to whom.
DO $$
DECLARE
  offending  bigint;
  worst      numeric;
  sample     text;
BEGIN
  SELECT count(*), min(balance_usd), string_agg(api_key_id::text, ', ')
    INTO offending, worst, sample
    FROM (
      SELECT api_key_id, balance_usd
        FROM credits_balance
       WHERE balance_usd < 0
       ORDER BY balance_usd ASC
       LIMIT 20
    ) AS t;

  IF COALESCE(offending, 0) > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'ARAS-0058: %s credits_balance row(s) are already negative (worst: %s USD); '
        'the non-negative constraint cannot be applied until they are reconciled',
        offending, worst),
      DETAIL  = format('api_key_id (first 20): %s', sample),
      HINT    = 'Reconcile each account against credits_ledger, then re-run this migration. '
                'Do not zero the balances: the deficit is the evidence.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Reserved funds.
--
-- Spendable balance is `balance_usd - held_usd`. `balance_usd` stays the
-- materialised SUM of the ledger, so a hold never has to be faked as a ledger
-- movement and the ledger remains the single source of truth.
ALTER TABLE "credits_balance"
  ADD COLUMN "held_usd" DECIMAL(12,6) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. The floor itself.
--
-- Every debit in BillingService is already guarded, but a guard in application
-- code is exactly the thing that races and exactly the thing a future caller
-- forgets. A CHECK constraint cannot be raced, cannot be forgotten, and cannot
-- be bypassed by a path nobody reviewed. It is the backstop, not the gate.
ALTER TABLE "credits_balance"
  ADD CONSTRAINT "credits_balance_balance_usd_non_negative" CHECK ("balance_usd" >= 0);

ALTER TABLE "credits_balance"
  ADD CONSTRAINT "credits_balance_held_usd_non_negative" CHECK ("held_usd" >= 0);

-- ---------------------------------------------------------------------------
-- 4. Request intents: the hold's owner, and the unit idempotency is measured in.
CREATE TABLE "request_intent" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "intent_key" TEXT NOT NULL,
    "client_supplied" BOOLEAN NOT NULL DEFAULT false,
    "hold_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'held',
    -- SHA-256 of the payload the key was first used with, so a replay carrying
    -- a DIFFERENT body is reported as the caller bug it is rather than
    -- answered with the first body.
    "payload_fingerprint" TEXT NOT NULL,
    "request_id" TEXT,
    "response" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "request_intent_pkey" PRIMARY KEY ("id")
);

-- Scoped to the api key, not global: two customers may pick the same
-- idempotency key, and one must never reach the other's stored response by
-- guessing it.
CREATE UNIQUE INDEX "request_intent_api_key_id_intent_key_key"
    ON "request_intent"("api_key_id", "intent_key");

-- The expiry sweep's access path.
CREATE INDEX "request_intent_state_expires_at_idx"
    ON "request_intent"("state", "expires_at");

ALTER TABLE "request_intent"
  ADD CONSTRAINT "request_intent_api_key_id_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "request_intent"
  ADD CONSTRAINT "request_intent_hold_usd_non_negative" CHECK ("hold_usd" >= 0);

-- ---------------------------------------------------------------------------
-- 5. The reconciler's access path.
--
-- It anti-joins Request against the ledger looking for measured spend that
-- never produced a ledger row. Unindexed, that is a sequential scan of the
-- entire ledger on every sweep.
CREATE INDEX "credits_ledger_request_id_idx" ON "credits_ledger"("request_id");
