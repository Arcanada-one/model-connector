import { createPrivateKey, createPublicKey } from 'node:crypto';
import { Pool } from 'pg';
import { service } from './fixture';
import { BenchRefused } from '../../src/bench-reservation/contract';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 65536) throw new Error('owned fixture stdin oversized');
  }
  const input = JSON.parse(raw);
  if (!input.socket.includes('/mc-owned-postgres/socket'))
    throw new Error('only owned local fixture database allowed');
  const primary = new Pool({
    host: input.socket,
    database: 'bench_primary_fixture',
    user: 'bench_primary_fixture_writer',
  });
  const checkpoint = new Pool({
    host: input.socket,
    database: 'bench_checkpoint_fixture',
    user: 'bench_checkpoint_fixture_writer',
  });
  try {
    const s = service(
      primary,
      checkpoint,
      createPublicKey(input.issuerPublic),
      createPrivateKey(input.custodianPrivate),
      input.jwks,
      input.now,
    );
    await s.reserve(input.signedGrant, input.request, input.token);
    console.log(JSON.stringify({ outcome: 'reserved', pid: process.pid }));
  } catch (error) {
    console.log(
      JSON.stringify({
        outcome: 'refused',
        condition: error instanceof BenchRefused ? error.condition : 'fixture_failed',
        pid: process.pid,
      }),
    );
  } finally {
    await primary.end();
    await checkpoint.end();
  }
}
void main();
