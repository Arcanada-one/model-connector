import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'prisma/migrations/20261117210000_clear_negative_catalog_sentinels/migration.sql',
);

describe('issue #106 negative catalogue sentinel migration', () => {
  it('clears negative per-1M tariffs to NULL without inventing replacements', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('UPDATE "model_catalog"');
    expect(migration).toContain('"inputPerMTok" < 0');
    expect(migration).toContain('"outputPerMTok" < 0');
    expect(migration).toMatch(/THEN NULL/);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    // Must not invent a replacement price; only NULL out negatives.
    expect(migration).not.toMatch(/SET\s+"inputPerMTok"\s*=\s*[0-9]/i);
  });
});
