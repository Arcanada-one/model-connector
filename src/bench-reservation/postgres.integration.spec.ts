import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import {
  material,
  service,
  seed,
  grantEnvelope,
  initial,
} from '../../test/bench-reservation/fixture';
import { signed, verifyEnvelope } from './signatures';
import { CheckpointStore } from './store';
import { requestSchema, CAPS } from './contract';

const socket = process.env.BENCH_OWNED_TEST_PG_SOCKET;
if (!socket || !socket.includes('/mc-owned-postgres/socket'))
  throw new Error('explicit owned no-TCP test socket required');
const primary = new Pool({ host: socket, database: 'bench_primary_fixture', user: 'dev' });
const checkpoint = new Pool({ host: socket, database: 'bench_checkpoint_fixture', user: 'dev' });
const primaryWriter = new Pool({
  host: socket,
  database: 'bench_primary_fixture',
  user: 'bench_primary_fixture_writer',
});
const checkpointWriter = new Pool({
  host: socket,
  database: 'bench_checkpoint_fixture',
  user: 'bench_checkpoint_fixture_writer',
});
const f = material(socket);
const s = service(
  primaryWriter,
  checkpointWriter,
  f.issuer.publicKey,
  f.custodian.privateKey,
  f.jwks,
  f.now,
);
const envelope = () => grantEnvelope(f.grant, f.issuer.privateKey);
beforeEach(async () => {
  // Disposable TEST schema only. Trigger removal is the explicit failure/restore
  // fixture, never a production migration, campaign mutation or refund action.
  await primary.query('DROP TABLE IF EXISTS bench_reservation,bench_campaign CASCADE');
  await checkpoint.query('DROP TABLE IF EXISTS bench_checkpoint_event,bench_checkpoint CASCADE');
  await primary.query(
    readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261001233000_bench_unknown_reservations/migration.sql',
      ),
      'utf8',
    ),
  );
  await checkpoint.query(
    readFileSync(join(process.cwd(), 'src/bench-reservation/checkpoint.sql'), 'utf8'),
  );
  await primary.query(
    'GRANT SELECT,INSERT,UPDATE ON bench_campaign,bench_reservation TO bench_primary_fixture_writer',
  );
  await checkpoint.query(
    'GRANT SELECT,INSERT,UPDATE ON bench_checkpoint,bench_checkpoint_event TO bench_checkpoint_fixture_writer',
  );
  await seed(primary, checkpoint, f.grant);
});
beforeAll(async () => {
  expect((await primary.query('SHOW fsync')).rows[0].fsync).toBe('on');
});
afterAll(async () => {
  await primary.end();
  await checkpoint.end();
  await primaryWriter.end();
  await checkpointWriter.end();
});
describe('actual isolated PostgreSQL campaign/custody boundary', () => {
  it('rejects actual superuser custody before spending any allowance', async () => {
    const unsafe = service(
      primary,
      checkpoint,
      f.issuer.publicKey,
      f.custodian.privateKey,
      f.jwks,
      f.now,
    );
    await expect(unsafe.reserve(envelope(), f.request, f.token)).rejects.toThrow(
      'database_custody_not_separate',
    );
    expect((await primary.query('SELECT sequence FROM bench_campaign')).rows[0].sequence).toBe(
      '180',
    );
  });
  it('commits both heads before authentic receipt and never releases a lost response', async () => {
    const receipt = await s.reserve(envelope(), f.request, f.token);
    const parsed = JSON.parse(
      verifyEnvelope(receipt, f.custodian.publicKey, 'BENCH-CUSTODY-RESERVATION-v1\n'),
    );
    expect(parsed.request).toEqual(f.request);
    expect(parsed.sequence).toBe(181);
    expect(parsed.aggregate).toEqual([181, 1725917, 327911]);
    expect((await primary.query('SELECT verdict FROM bench_reservation')).rows[0].verdict).toBe(
      'UNKNOWN_NO_RELEASE',
    );
    await expect(
      s.reserve(envelope(), { ...f.request, nonce: '7'.repeat(64) }, f.token),
    ).rejects.toThrow('attempt_or_nonce_already_reserved');
    expect((await new CheckpointStore(checkpoint).read(f.grant.campaign)).sequence).toBe(181);
    await expect(primary.query('DELETE FROM bench_reservation')).rejects.toThrow('immutable');
  });
  it('competing REAL OS processes admit only one physical reservation', async () => {
    const input = {
      socket,
      issuerPublic: f.issuer.publicKey.export({ format: 'pem', type: 'spki' }),
      custodianPrivate: f.custodian.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      jwks: f.jwks,
      now: f.now,
      signedGrant: envelope(),
      request: f.request,
      token: f.token,
    };
    const outputs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<{ outcome: string; pid: number }>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                '-r',
                'ts-node/register/transpile-only',
                'test/bench-reservation/process.fixture.ts',
              ],
              {
                cwd: process.cwd(),
                env: {
                  PATH: '/usr/bin:/bin',
                  HOME: process.env.HOME,
                  TMPDIR: process.env.TMPDIR,
                  NODE_DISABLE_COMPILE_CACHE: '1',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
              },
            );
            let output = '';
            let error = '';
            child.stdout.on('data', (b) => (output += b));
            child.stderr.on('data', (b) => (error += b));
            const timeout = setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error('owned fixture child timeout'));
            }, 15000);
            child.on('exit', (code) => {
              clearTimeout(timeout);
              if (code !== 0) reject(new Error('owned child nonzero:' + error));
              else resolve(JSON.parse(output.trim()));
            });
            child.stdin.end(JSON.stringify(input));
          }),
      ),
    );
    expect(new Set(outputs.map((o) => o.pid)).size).toBe(6);
    expect(outputs.filter((o) => o.outcome === 'reserved')).toHaveLength(1);
    expect((await primary.query('SELECT count(*) AS n FROM bench_reservation')).rows[0].n).toBe(
      '1',
    );
    expect(
      (await checkpoint.query('SELECT count(*) AS n FROM bench_checkpoint_event')).rows[0].n,
    ).toBe('1');
  });
  it('freezes after external commit then failed local insert, retaining unknown charge', async () => {
    await primary.query(
      `CREATE OR REPLACE FUNCTION fixture_fail_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned local failure'; END $$`,
    );
    await primary.query(
      'CREATE TRIGGER fixture_fail BEFORE INSERT ON bench_reservation FOR EACH ROW EXECUTE FUNCTION fixture_fail_insert()',
    );
    await expect(s.reserve(envelope(), f.request, f.token)).rejects.toThrow();
    expect((await primary.query('SELECT sequence FROM bench_campaign')).rows[0].sequence).toBe(
      '180',
    );
    expect((await new CheckpointStore(checkpoint).read(f.grant.campaign)).sequence).toBe(181);
    await primary.query('DROP TRIGGER fixture_fail ON bench_reservation');
    await expect(s.reserve(envelope(), f.request, f.token)).rejects.toThrow(
      'restart_or_rollback_head_mismatch',
    );
    expect(
      (await checkpoint.query('SELECT count(*) AS n FROM bench_checkpoint_event')).rows[0].n,
    ).toBe('1');
  });
  it('rejects restored old primary state against independently retained latest checkpoint', async () => {
    await s.reserve(envelope(), f.request, f.token);
    await primary.query('DROP TABLE bench_reservation,bench_campaign CASCADE');
    await primary.query(
      readFileSync(
        join(
          process.cwd(),
          'prisma/migrations/20261001233000_bench_unknown_reservations/migration.sql',
        ),
        'utf8',
      ),
    );
    await primary.query(
      'GRANT SELECT,INSERT,UPDATE ON bench_campaign,bench_reservation TO bench_primary_fixture_writer',
    );
    const h = initial(f.grant);
    await primary.query(`INSERT INTO bench_campaign VALUES($1,$2,$3,$4,$5,$6,$7)`, [
      h.campaign,
      f.grant.original_ledger_sha256,
      h.journal,
      ...h.aggregate,
      h.head,
    ]);
    const nextGrant = { ...f.grant, attempt: 'new-attempt-fixture' };
    await expect(
      s.reserve(
        grantEnvelope(nextGrant, f.issuer.privateKey),
        { ...f.request, attempt: nextGrant.attempt, nonce: '9'.repeat(64) },
        f.token,
      ),
    ).rejects.toThrow('restart_or_rollback_head_mismatch');
  });
  it('rejects restored checkpoint, different journal and malformed native body without reset', async () => {
    await s.reserve(envelope(), f.request, f.token);
    await primary.query(
      'GRANT SELECT,INSERT,UPDATE ON bench_campaign,bench_reservation TO bench_primary_fixture_writer',
    );
    const h = initial(f.grant);
    await checkpoint.query(
      'UPDATE bench_checkpoint SET sequence=$1,input_tokens=$2,output_tokens=$3,head_sha256=$4',
      [...h.aggregate, h.head],
    );
    const grant = { ...f.grant, attempt: 'next-attempt-fixture' };
    await expect(
      s.reserve(
        grantEnvelope(grant, f.issuer.privateKey),
        { ...f.request, attempt: grant.attempt, nonce: 'a'.repeat(64) },
        f.token,
      ),
    ).rejects.toThrow('restart_or_rollback_head_mismatch');
    await expect(
      s.reserve(envelope(), { ...f.request, journal_id: 'different-empty-journal' }, f.token),
    ).rejects.toThrow();
    await expect(s.reserve(envelope(), { ...f.request, unknown: true }, f.token)).rejects.toThrow();
    expect((await primary.query('SELECT count(*) AS n FROM bench_reservation')).rows[0].n).toBe(
      '1',
    );
  });

  it('local deferred commit failure consumes external allowance and freezes restart', async () => {
    await primary.query(
      `CREATE OR REPLACE FUNCTION fixture_fail_commit() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned commit failure'; END $$`,
    );
    await primary.query(
      'CREATE CONSTRAINT TRIGGER fixture_commit_fail AFTER INSERT ON bench_reservation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_fail_commit()',
    );
    await expect(s.reserve(envelope(), f.request, f.token)).rejects.toThrow();
    expect((await primary.query('SELECT sequence FROM bench_campaign')).rows[0].sequence).toBe(
      '180',
    );
    expect((await new CheckpointStore(checkpoint).read(f.grant.campaign)).sequence).toBe(181);
    await primary.query('DROP TRIGGER fixture_commit_fail ON bench_reservation');
    await expect(s.reserve(envelope(), f.request, f.token)).rejects.toThrow(
      'restart_or_rollback_head_mismatch',
    );
  });
  it('checkpoint deferred commit failure yields no signed permit or local reservation', async () => {
    await checkpoint.query(
      `CREATE OR REPLACE FUNCTION fixture_checkpoint_commit() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned checkpoint failure'; END $$`,
    );
    await checkpoint.query(
      'CREATE CONSTRAINT TRIGGER fixture_checkpoint_fail AFTER INSERT ON bench_checkpoint_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_checkpoint_commit()',
    );
    await expect(s.reserve(envelope(), f.request, f.token)).rejects.toThrow();
    expect((await primary.query('SELECT count(*) AS n FROM bench_reservation')).rows[0].n).toBe(
      '0',
    );
    expect((await new CheckpointStore(checkpoint).read(f.grant.campaign)).sequence).toBe(180);
  });
  it('refuses nonce replay under a separately signed new attempt', async () => {
    await s.reserve(envelope(), f.request, f.token);
    const grant = { ...f.grant, attempt: 'second-attempt-fixture' };
    await expect(
      s.reserve(
        grantEnvelope(grant, f.issuer.privateKey),
        { ...f.request, attempt: grant.attempt },
        f.token,
      ),
    ).rejects.toThrow('attempt_or_nonce_already_reserved');
    expect((await new CheckpointStore(checkpoint).read(f.grant.campaign)).sequence).toBe(181);
  });
  it('detects missing local reservation after privileged owned-fixture corruption', async () => {
    await s.reserve(envelope(), f.request, f.token);
    await primary.query(
      'ALTER TABLE bench_reservation DISABLE TRIGGER bench_reservation_no_mutation',
    );
    await primary.query('DELETE FROM bench_reservation');
    await primary.query(
      'ALTER TABLE bench_reservation ENABLE TRIGGER bench_reservation_no_mutation',
    );
    const grant = { ...f.grant, attempt: 'third-attempt-fixture' };
    await expect(
      s.reserve(
        grantEnvelope(grant, f.issuer.privateKey),
        { ...f.request, attempt: grant.attempt, nonce: 'c'.repeat(64) },
        f.token,
      ),
    ).rejects.toThrow('local_head_not_complete_chain');
    expect((await new CheckpointStore(checkpoint).read(f.grant.campaign)).sequence).toBe(181);
  });
  it('retains all caps when concurrent distinct attempts consume conservative hard maximum', async () => {
    for (let n = 0; n < 10; n++) {
      const grant = { ...f.grant, attempt: `max-${n}` };
      await s.reserve(
        grantEnvelope(grant, f.issuer.privateKey),
        { ...f.request, attempt: grant.attempt, nonce: n.toString(16).padStart(64, '0') },
        f.token,
      );
    }
    const grant = { ...f.grant, attempt: 'max-11' };
    await expect(
      s.reserve(
        grantEnvelope(grant, f.issuer.privateKey),
        { ...f.request, attempt: grant.attempt, nonce: 'b'.repeat(64) },
        f.token,
      ),
    ).rejects.toThrow('campaign_cap_exhausted');
    const h = await new CheckpointStore(checkpoint).read(f.grant.campaign);
    expect(h.aggregate[2]).toBe(1479911);
    expect(h.aggregate.every((v, i) => v <= CAPS[i])).toBe(true);
  });
  it('requires separately signed bootstrap and genuine provision scope, no second lineage reset', async () => {
    await primary.query('DROP TABLE bench_reservation,bench_campaign CASCADE');
    await checkpoint.query('DROP TABLE bench_checkpoint_event,bench_checkpoint CASCADE');
    await primary.query(
      readFileSync(
        join(
          process.cwd(),
          'prisma/migrations/20261001233000_bench_unknown_reservations/migration.sql',
        ),
        'utf8',
      ),
    );
    await checkpoint.query(
      readFileSync(join(process.cwd(), 'src/bench-reservation/checkpoint.sql'), 'utf8'),
    );
    await primary.query(
      'GRANT SELECT,INSERT,UPDATE ON bench_campaign,bench_reservation TO bench_primary_fixture_writer',
    );
    await checkpoint.query(
      'GRANT SELECT,INSERT,UPDATE ON bench_checkpoint,bench_checkpoint_event TO bench_checkpoint_fixture_writer',
    );
    const bootstrap = signed(f.grant, f.issuer.privateKey, 'BENCH-CUSTODY-BOOTSTRAP-v1\n');
    await expect(s.provision(bootstrap, f.token)).rejects.toThrow();
    const body = Buffer.from(JSON.stringify({ ...f.claims, scope: 'bench:provision' })).toString(
      'base64url',
    );
    const token = `${f.header}.${body}.${sign('RSA-SHA256', Buffer.from(f.header + '.' + body), f.identity.privateKey).toString('base64url')}`;
    await s.provision(bootstrap, token);
    await expect(s.provision(bootstrap, token)).rejects.toThrow();
    const clone = { ...f.grant, campaign: 'another-empty-campaign', journal_id: 'another-journal' };
    await expect(
      s.provision(signed(clone, f.issuer.privateKey, 'BENCH-CUSTODY-BOOTSTRAP-v1\n'), token),
    ).rejects.toThrow();
    expect((await primary.query('SELECT count(*) AS n FROM bench_campaign')).rows[0].n).toBe('1');
    expect(requestSchema.parse(f.request)).toEqual(f.request);
  });
});
