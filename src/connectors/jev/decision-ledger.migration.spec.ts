import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'prisma/migrations/20261111030000_conn_jev_06_decision_ledger/migration.sql',
);

describe('CONN-JEV-06 DecisionLedger migration', () => {
  it('defines DecisionLedger/v1 table with digests and append-only trigger', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const migration = readFileSync(migrationPath, 'utf8');

    expect(schema).toContain('model DecisionLedger');
    expect(schema).toContain('identityDigest');
    expect(schema).toContain('stateDigest');
    expect(schema).toContain('templateDigest');
    expect(schema).toContain('routeDigest');
    expect(schema).toContain('@@map("decision_ledger")');

    expect(migration).toContain('CREATE TABLE "decision_ledger"');
    expect(migration).toContain('"identity_digest"');
    expect(migration).toContain('"state_digest"');
    expect(migration).toContain('"template_digest"');
    expect(migration).toContain('"route_digest"');
    expect(migration).toContain('decision_ledger_identity_digest_key');
    expect(migration).toContain('enforce_decision_ledger_append_only');
    expect(migration).toContain('DecisionLedger/v1 rows are append-only');
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON "decision_ledger"/);
    expect(migration).toContain('decision_ledger_cost_usd_usage_missing');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
  });

  it('negative control: UPDATE is refused by trigger (SQL contract)', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toMatch(/CREATE TRIGGER "decision_ledger_append_only"/);
    expect(migration).toMatch(/RAISE EXCEPTION 'DecisionLedger\/v1 rows are append-only'/);
    // No UPDATE path is granted — only the raise on UPDATE OR DELETE.
    expect(migration).not.toMatch(/IF TG_OP = 'UPDATE' THEN\s+RETURN NEW/s);
  });
});
