-- BILL-0008 / ARAS-0058 phase 7 — make the ledger able to receive real money,
-- and able to give it back.
--
-- Everything here has to land BEFORE the first payment, not after it, and the
-- reason is the same for every item: none of it can be backfilled. A rate at
-- receipt is gone the moment it passes. A gateway reference exists only in the
-- event that carried it. And whether a row was live or sandbox money is not
-- recoverable by inspection once both live in the same table.
--
-- Design source of truth: datarim/research/ARAS-0058/consilium-payments.md
-- §4 (blocking list) and §6 (confirmed live findings).

-- ---------------------------------------------------------------------------
-- 1. Refuse to proceed on data the new constraints would reject.
--
-- Same discipline as 20260829120000: a CHECK added over existing rows fails
-- naming no row, and whoever is watching the deploy needs to know WHICH rows
-- and why, because that decides whether the fix is a data repair or a
-- rollback. Look first, and say so.
DO $$
DECLARE
  offending bigint;
  sample    text;
BEGIN
  SELECT count(*), string_agg(DISTINCT COALESCE(entry_type, '<null>'), ', ')
    INTO offending, sample
    FROM credits_ledger
   WHERE entry_type IS NULL
      OR entry_type NOT IN
         ('charge', 'gift', 'credit', 'uncollectible', 'payment', 'refund', 'chargeback');

  IF COALESCE(offending, 0) > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'BILL-0008: %s credits_ledger row(s) carry an entry_type outside the '
        'permitted set (found: %s); the entry_type constraint cannot be applied',
        offending, sample),
      HINT = 'Classify each row against the permitted set before re-running. '
             'Do not bulk-update them to ''charge'': mislabelling a credit as '
             'a debit is the exact defect this migration exists to prevent.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. entry_type: drop the default, make it required, constrain the values.
--
-- Consilium §6.5. `entry_type String @default("charge")` meant a caller that
-- never set the field posted a row labelled a debit. For the paths that existed
-- when it was written that was merely untidy — every one of them set the field.
-- For a payment it is a correctness failure with no tell: money a customer
-- actually sent, recorded in the history as spend, arithmetic still correct,
-- and no reader able to notice.
--
-- Dropping the default is the load-bearing half. NOT NULL alone would still let
-- the default silently supply 'charge'; it is the ABSENCE of a default that
-- turns a forgotten field into a rejected INSERT.
ALTER TABLE "credits_ledger" ALTER COLUMN "entry_type" DROP DEFAULT;
ALTER TABLE "credits_ledger" ALTER COLUMN "entry_type" SET NOT NULL;

ALTER TABLE "credits_ledger"
  ADD CONSTRAINT "credits_ledger_entry_type_known" CHECK (
    "entry_type" IN ('charge', 'gift', 'credit', 'uncollectible', 'payment', 'refund', 'chargeback')
  );

-- ---------------------------------------------------------------------------
-- 3. Payment provenance and crypto valuation.
--
-- All nullable with no default, for the same reason `Request.cost_source` is:
-- rows written before this shipped genuinely have no provenance, and
-- back-filling them with a guess would invent evidence. NULL here means "not a
-- payment", never "a payment whose details we lost" — §4 below makes the
-- latter impossible to write.
--
-- The valuation columns are DECIMAL(38,18), not the ledger's (12,6). A satoshi
-- is 1e-8 BTC and a wei is 1e-18 ETH; the precision has nothing to do with
-- dollars, and that is the point. `amount_usd` is the ledger number and the
-- only one any money query may read. These are the audit record of how that USD
-- number came to exist — "the customer paid 0.0031 BTC and we called it $180"
-- is a claim we must be able to reproduce and cannot reconstruct.
ALTER TABLE "credits_ledger" ADD COLUMN "source"              TEXT;
ALTER TABLE "credits_ledger" ADD COLUMN "external_ref"        TEXT;
ALTER TABLE "credits_ledger" ADD COLUMN "livemode"            BOOLEAN;
ALTER TABLE "credits_ledger" ADD COLUMN "asset_amount"        DECIMAL(38,18);
ALTER TABLE "credits_ledger" ADD COLUMN "asset"               TEXT;
ALTER TABLE "credits_ledger" ADD COLUMN "usd_rate_at_receipt" DECIMAL(38,18);
ALTER TABLE "credits_ledger" ADD COLUMN "valued_at"           TIMESTAMP(3);
ALTER TABLE "credits_ledger" ADD COLUMN "reversal_of"         TEXT;
ALTER TABLE "credits_ledger" ADD COLUMN "actor"               TEXT;

-- ---------------------------------------------------------------------------
-- 4. What a payment row must carry, and what a reversal row must carry.
--
-- Written as `entry_type <> 'payment' OR ...` so the constraint says nothing at
-- all about the rows it does not govern. A charge has no `source` and never
-- will; the CHECK must not have an opinion about it.
--
-- `livemode` is included because consilium §5's sandbox trap makes it the only
-- boundary that exists when a gateway's sandbox shares a signing key with live:
-- a payment row that cannot say which side it came from is unusable evidence.
ALTER TABLE "credits_ledger"
  ADD CONSTRAINT "credits_ledger_payment_has_provenance" CHECK (
    "entry_type" <> 'payment'
    OR ("source" IS NOT NULL AND "livemode" IS NOT NULL)
  );

-- A reversal that names no original is an unexplained negative entry — the
-- hand-written row outside every invariant that the reverse() primitive exists
-- to make unnecessary.
ALTER TABLE "credits_ledger"
  ADD CONSTRAINT "credits_ledger_reversal_names_original" CHECK (
    "entry_type" NOT IN ('refund', 'chargeback')
    OR "reversal_of" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 5. Sign discipline for the new types.
--
-- A payment credits, a reversal debits, and neither may be zero — a zero-amount
-- row of either kind burns an idempotency key while moving nothing, so the real
-- event that follows under the same key is swallowed silently.
--
-- Scoped DELIBERATELY to the three new types. The obvious next move is to
-- assert the sign of 'charge'/'gift'/'credit'/'uncollectible' too, and it is
-- declined: those rows exist on a production database this migration cannot
-- inspect (see the memory note on prod reachability), and a CHECK that fails
-- mid-deploy on historical data is a worse outcome than an unasserted invariant
-- on paths that already enforce it in code. The new types have no history, so
-- asserting them costs nothing and is airtight from the first row.
ALTER TABLE "credits_ledger"
  ADD CONSTRAINT "credits_ledger_payment_positive" CHECK (
    "entry_type" <> 'payment' OR "amount_usd" > 0
  );

ALTER TABLE "credits_ledger"
  ADD CONSTRAINT "credits_ledger_reversal_negative" CHECK (
    "entry_type" NOT IN ('refund', 'chargeback') OR "amount_usd" < 0
  );

-- ---------------------------------------------------------------------------
-- 6. Key revocation must not destroy a receipt.
--
-- Consilium §6.4. The FK was ON DELETE CASCADE: revoking an API key deleted its
-- entire ledger history. Survivable while every row was an operator gift or our
-- own measured spend, and not survivable the moment a row records money a
-- stranger actually sent — the receipt for an irreversible crypto payment has
-- no second copy anywhere to rebuild from.
--
-- RESTRICT means a key with ledger history cannot be deleted at all. That is
-- the intended answer rather than an inconvenience: such a key is not a row to
-- delete, it is a row to DEACTIVATE, which `ApiKey.active` already expresses
-- and the admin surface already does. Nothing in the shipped code deletes an
-- ApiKey.
--
-- Note the deliberate asymmetry with `credits_balance` and `request_intent`,
-- which stay CASCADE. Both are derived state — a balance is a materialised SUM
-- of the ledger and an intent is a transient hold. Neither is evidence, and
-- keeping them would only strand rows pointing at a key that no longer exists.
-- The ledger is the only one of the three that is the record itself.
ALTER TABLE "credits_ledger" DROP CONSTRAINT "credits_ledger_api_key_id_fkey";
ALTER TABLE "credits_ledger"
  ADD CONSTRAINT "credits_ledger_api_key_id_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES "ApiKey"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7. Access paths.
CREATE INDEX "credits_ledger_source_external_ref_idx"
  ON "credits_ledger"("source", "external_ref");

-- Asked on every reversal, to refuse reversing the same entry twice.
CREATE INDEX "credits_ledger_reversal_of_idx"
  ON "credits_ledger"("reversal_of");
