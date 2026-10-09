// Seed ONE API key into the run's own disposable database.
// DATABASE_URL must be the owned store created by scripts/owned_stores.py; the raw key
// arrives in INTEGRATION_API_KEY (generated per run, never printed or stored).
import bcrypt from 'bcryptjs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const raw = process.env.INTEGRATION_API_KEY;
if (!url || !raw) {
  console.error('DATABASE_URL and INTEGRATION_API_KEY are required');
  process.exit(2);
}
// Refuse anything that is not a local owned store: a Unix socket, or loopback.
const parsed = new URL(url);
const local = parsed.searchParams.get('host')?.startsWith('/') || ['127.0.0.1', 'localhost'].includes(parsed.hostname);
if (!local) {
  console.error('refusing to seed a non-local database');
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const hash = await bcrypt.hash(raw, 4);
  await client.query(
    'INSERT INTO "ApiKey" (id, name, "keyHash") VALUES (gen_random_uuid()::text, $1, $2)',
    ['owned-run-integration', hash],
  );
} finally {
  await client.end();
}
console.log('seeded 1 api key');
