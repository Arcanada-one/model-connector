-- Supplier exposure is separate from customer credits. No TTL releases money.
CREATE TABLE profile_spend_account (
  id text PRIMARY KEY,
  owner_profile_id text NOT NULL UNIQUE,
  ledger_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_sequence bigint NOT NULL DEFAULT 0,
  currency text NOT NULL CHECK (currency='USD'),
  profile_bindings jsonb NOT NULL,
  paused_profiles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE profile_spend_key_binding (
  api_key_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES profile_spend_account(id)
);
CREATE TABLE profile_spend_call (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES profile_spend_account(id),
  api_key_id text NOT NULL,
  intent_key text NOT NULL,
  digest text NOT NULL,
  profile_id text NOT NULL,
  provider text NOT NULL,
  credential_ref text NOT NULL,
  credential_version text NOT NULL,
  model text NOT NULL,
  run_id text NOT NULL,
  nodes text[] NOT NULL,
  currency text NOT NULL CHECK(currency='USD'),
  state text NOT NULL CHECK(state IN ('reserved','claimed','dispatch_started','completed','uncertain')),
  reserve_nano numeric(30,0) NOT NULL CHECK(reserve_nano>=0),
  observed_nano numeric(30,0),
  charged_nano numeric(30,0) NOT NULL CHECK(charged_nano>=reserve_nano),
  input_tokens bigint,
  output_tokens bigint,
  served_model text,
  provider_request_id text,
  response_seen boolean NOT NULL DEFAULT false,
  egress_started boolean NOT NULL DEFAULT false,
  reconciliation text NOT NULL DEFAULT 'NOT_MEASURED',
  policy_revision text NOT NULL,
  policy_hash text NOT NULL,
  tariff_revision text NOT NULL,
  tariff_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  admitted_at timestamptz NOT NULL,
  finished_at timestamptz,
  reason_code text,
  UNIQUE(account_id,run_id,intent_key)
);
CREATE INDEX profile_spend_call_period ON profile_spend_call(account_id,admitted_at);
CREATE INDEX profile_spend_call_profile ON profile_spend_call(account_id,profile_id,admitted_at);
CREATE INDEX profile_spend_call_run ON profile_spend_call(account_id,run_id);
CREATE TABLE profile_spend_event (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES profile_spend_account(id),
  sequence bigint NOT NULL,
  call_id uuid NOT NULL REFERENCES profile_spend_call(id),
  kind text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,sequence)
);
CREATE TABLE profile_spend_alert_outbox (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES profile_spend_account(id),
  scope_key text NOT NULL,
  period text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  policy_revision text NOT NULL,
  status text NOT NULL DEFAULT 'delivery_pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,scope_key,period,period_start,policy_revision)
);
