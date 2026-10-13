import { createPublicKey, generateKeyPairSync, sign, KeyObject } from 'node:crypto';
import { Pool } from 'pg';
import {
  CAPS,
  FLOOR,
  ORIGINAL_LEDGER,
  Grant,
  ReservationRequest,
  Head,
} from '../../src/bench-reservation/contract';
import { canonical, digest, signed } from '../../src/bench-reservation/signatures';
import { CampaignStore, CheckpointStore } from '../../src/bench-reservation/store';
import { BenchReservationService } from '../../src/bench-reservation/service';

// Synthetic keys exist only in the owned test process/stdin. They are not live
// Auth Arcana or BENCH keys, runtime grant files, credentials or provider calls.
export function material(socket: string) {
  const issuer = generateKeyPairSync('ed25519');
  const custodian = generateKeyPairSync('ed25519');
  const identity = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...identity.publicKey.export({ format: 'jwk' }),
    kid: 'owned-fixture',
    alg: 'RS256',
    use: 'sig',
  };
  const jwks = JSON.stringify({ keys: [jwk] });
  const now = Math.floor(Date.now() / 1000);
  const grant: Grant = {
    schema: 'NativeBenchAdmission/v1',
    campaign: 'original-budget-fixture',
    subject: 'full-frame-fixture',
    attempt: 'attempt-fixture',
    account: 'account-fixture',
    provider: 'chatgpt-subscription',
    model: 'gpt-6-luna',
    source_sha256: '1'.repeat(64),
    binary_sha256: '2'.repeat(64),
    expires_unix: now + 300,
    caps: [...CAPS],
    retained_baseline: [...FLOOR],
    old_consumption_proof_sha256: '3'.repeat(64),
    bounds_proof_sha256: '4'.repeat(64),
    hard_output_tokens: 128000,
    input_policy: 'TEXT_ONLY_UTF8_BYTES_UPPER_BOUND',
    output_policy: 'AUTHENTICATED_MODEL_HARD_MAXIMUM_NO_RELEASE',
    custodian_socket: socket,
    journal_id: 'original-journal-fixture',
    custodian_public_key: Buffer.from(
      custodian.publicKey.export({ format: 'jwk' }).x!,
      'base64url',
    ).toString('hex'),
    caller_subject: 'auth-caller-fixture',
    auth_audience: 'auth-audience-fixture',
    auth_jwks_sha256: digest(jwks),
    original_ledger_sha256: ORIGINAL_LEDGER,
  };
  const request: ReservationRequest = {
    schema: 'NativeBenchReservationRequest/v1',
    campaign: grant.campaign,
    subject: grant.subject,
    attempt: grant.attempt,
    account: grant.account,
    provider: grant.provider,
    model: grant.model,
    source_sha256: grant.source_sha256,
    binary_sha256: grant.binary_sha256,
    journal_id: grant.journal_id,
    wire_sha256: '5'.repeat(64),
    reserved: [1, 30000, 128000],
    caps: [...CAPS],
    retained_baseline: [...FLOOR],
    nonce: '6'.repeat(64),
  };
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'owned-fixture', typ: 'JWT' }),
  ).toString('base64url');
  const claims = {
    iss: 'https://auth.arcanada.ai',
    sub: grant.caller_subject,
    aud: grant.auth_audience,
    exp: now + 300,
    iat: now,
    scope: 'bench:reserve',
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${header}.${body}.${sign('RSA-SHA256', Buffer.from(header + '.' + body), identity.privateKey).toString('base64url')}`;
  return { issuer, custodian, identity, jwks, now, grant, request, token, claims, header };
}
export function service(
  primary: Pool,
  checkpoint: Pool,
  issuer: KeyObject,
  custodian: KeyObject,
  jwks: string,
  now: number,
) {
  return new BenchReservationService({
    campaign: new CampaignStore(primary),
    checkpoint: new CheckpointStore(checkpoint),
    issuerPublicKey: issuer,
    custodianPrivateKey: custodian,
    authArcanaJwks: jwks,
    now: () => now,
  });
}
export function initial(grant: Grant): Head {
  return {
    campaign: grant.campaign,
    journal: grant.journal_id,
    sequence: FLOOR[0],
    aggregate: [...FLOOR],
    head: digest(
      canonical({
        original_ledger_sha256: ORIGINAL_LEDGER,
        journal: grant.journal_id,
        baseline: FLOOR,
      }),
    ),
  };
}
export async function seed(primary: Pool, checkpoint: Pool, grant: Grant) {
  const h = initial(grant);
  for (const [pool, table] of [
    [primary, 'bench_campaign'],
    [checkpoint, 'bench_checkpoint'],
  ] as const) {
    const fields = table === 'bench_campaign' ? ',original_ledger_sha256' : '';
    const slot = table === 'bench_campaign' ? ',$7' : '';
    await pool.query(
      `INSERT INTO ${table}(campaign,journal_id,sequence,input_tokens,output_tokens,head_sha256${fields}) VALUES($1,$2,$3,$4,$5,$6${slot})`,
      [
        h.campaign,
        h.journal,
        ...h.aggregate,
        h.head,
        ...(table === 'bench_campaign' ? [ORIGINAL_LEDGER] : []),
      ],
    );
  }
}
export function grantEnvelope(grant: Grant, key: KeyObject) {
  return signed(grant, key, 'BENCH-GRANT-v1\n');
}
export function issuerPublic(key: KeyObject) {
  return createPublicKey(key);
}
