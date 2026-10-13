-- Source-only additive migration. No production migration or startup provisioning.
CREATE TABLE strict_supplier_intent (
  api_key_id TEXT NOT NULL REFERENCES "ApiKey"(id) ON DELETE RESTRICT,
  intent_key TEXT NOT NULL,
  attempt TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0),
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  model TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector = 'deepseek'),
  state TEXT NOT NULL CHECK (state IN ('dispatch_started','completed','uncertain')),
  exposure JSONB NOT NULL CHECK (jsonb_typeof(exposure)='object'
    AND exposure ?& ARRAY['units','scale','admission','rate','checkpoint','capability','source','deployment','encoder','hard_output']
    AND exposure - ARRAY['units','scale','admission','rate','checkpoint','capability','source','deployment','encoder','hard_output'] = '{}'::jsonb
    AND jsonb_typeof(exposure->'units')='string' AND exposure->>'units' ~ '^[0-9]{1,38}$'
    AND jsonb_typeof(exposure->'scale')='number' AND exposure->>'scale' ~ '^(0|[1-9]|1[0-8])$'
    AND exposure->>'admission' ~ '^[a-f0-9]{64}$' AND exposure->>'rate' ~ '^[a-f0-9]{64}$'
    AND exposure->>'checkpoint' ~ '^[a-f0-9]{64}$' AND exposure->>'capability' ~ '^[a-f0-9]{64}$'
    AND exposure->>'source' ~ '^[a-f0-9]{64}$' AND exposure->>'deployment' ~ '^[a-f0-9]{64}$'
    AND exposure->>'encoder' ~ '^[a-f0-9]{64}$' AND exposure->>'hard_output' ~ '^[a-f0-9]{64}$'),
  receipt JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id,intent_key)
);
-- No TTL/release/delete/re-dispatch procedure exists. Original deployment custodian
-- must qualify restricted DB writer permissions and grant lineage before activation.
