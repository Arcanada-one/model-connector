-- BENCH token policy is separate from commercial credit/payment tables.
CREATE TABLE bench_campaign (
  campaign TEXT PRIMARY KEY,
  original_ledger_sha256 TEXT NOT NULL UNIQUE CHECK (original_ledger_sha256 = '416715bbf4b6f25a3ef9bb0c3085651792f66548789239e2e96c093e7e7e26fb'),
  journal_id TEXT NOT NULL UNIQUE,
  sequence BIGINT NOT NULL CHECK (sequence BETWEEN 180 AND 528),
  input_tokens BIGINT NOT NULL CHECK (input_tokens BETWEEN 1695917 AND 10000000),
  output_tokens BIGINT NOT NULL CHECK (output_tokens BETWEEN 199911 AND 1500000),
  head_sha256 TEXT NOT NULL CHECK (head_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE TABLE bench_reservation (
  campaign TEXT NOT NULL REFERENCES bench_campaign(campaign),
  attempt TEXT NOT NULL,
  nonce TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  grant_sha256 TEXT NOT NULL,
  request JSONB NOT NULL,
  previous_head_sha256 TEXT NOT NULL,
  head_sha256 TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict = 'UNKNOWN_NO_RELEASE'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign, attempt),
  UNIQUE (campaign, nonce), UNIQUE (campaign, sequence)
);
CREATE OR REPLACE FUNCTION bench_reservation_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BENCH reservations are immutable; unknowns never release';
END $$;
CREATE TRIGGER bench_reservation_no_mutation BEFORE UPDATE OR DELETE ON bench_reservation
FOR EACH ROW EXECUTE FUNCTION bench_reservation_immutable();
