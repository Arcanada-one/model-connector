-- Install only in a separately owned checkpoint database/trust domain.
-- Never apply this to the primary MC database as an alleged independent anchor.
CREATE TABLE bench_checkpoint (
  campaign TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL UNIQUE,
  sequence BIGINT NOT NULL CHECK (sequence BETWEEN 180 AND 528),
  input_tokens BIGINT NOT NULL CHECK (input_tokens BETWEEN 1695917 AND 10000000),
  output_tokens BIGINT NOT NULL CHECK (output_tokens BETWEEN 199911 AND 1500000),
  head_sha256 TEXT NOT NULL CHECK (head_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE TABLE bench_checkpoint_event (
  campaign TEXT NOT NULL REFERENCES bench_checkpoint(campaign),
  sequence BIGINT NOT NULL,
  attempt TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request JSONB NOT NULL,
  previous_head_sha256 TEXT NOT NULL,
  head_sha256 TEXT NOT NULL,
  PRIMARY KEY(campaign, sequence), UNIQUE(campaign, attempt), UNIQUE(campaign, nonce)
);
CREATE OR REPLACE FUNCTION bench_checkpoint_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'BENCH checkpoint events are immutable'; END $$;
CREATE TRIGGER bench_checkpoint_no_mutation BEFORE UPDATE OR DELETE ON bench_checkpoint_event
FOR EACH ROW EXECUTE FUNCTION bench_checkpoint_immutable();
