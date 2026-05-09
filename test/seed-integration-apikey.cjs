/**
 * Seeds a test API key into the local dev Postgres for integration tests.
 * Run once before `pnpm test:integration`:
 *   node test/seed-integration-apikey.cjs
 *
 * Requires: mc-dev-postgres container running on localhost:5434
 * Key ID: int-test-apikey-conn0052
 * Raw key: mc-integration-test-key-conn0052 (set as INTEGRATION_API_KEY in .env.integration)
 */
'use strict';

const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const RAW_KEY = 'mc-integration-test-key-conn0052';
const KEY_ID = 'int-test-apikey-conn0052';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:devpass@localhost:5434/arcanada_connector';

async function main() {
  const hash = await bcrypt.hash(RAW_KEY, 10);
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  await client.query('DELETE FROM "ApiKey" WHERE id = $1', [KEY_ID]);
  await client.query(
    'INSERT INTO "ApiKey" (id, name, "keyHash", "rateLimit", active, "createdAt") VALUES ($1, $2, $3, $4, $5, NOW())',
    [KEY_ID, 'Integration Test Key CONN-0052', hash, 100, true],
  );

  console.log('Seeded API key:', KEY_ID);
  console.log('Raw key:', RAW_KEY);
  await client.end();
}

main().catch((e) => {
  console.error('Seed failed:', e.message);
  process.exit(1);
});
