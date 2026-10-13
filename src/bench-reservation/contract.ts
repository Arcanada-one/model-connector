import { z } from 'zod';

export const CAPS = [528, 10_000_000, 1_500_000] as const;
export const FLOOR = [180, 1_695_917, 199_911] as const;
export const ORIGINAL_LEDGER = '416715bbf4b6f25a3ef9bb0c3085651792f66548789239e2e96c093e7e7e26fb';
const id = z.string().min(1).max(256);
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
export const counters = z.tuple([count, count, count]);
export const grantSchema = z
  .object({
    schema: z.literal('NativeBenchAdmission/v1'),
    campaign: id,
    subject: id,
    attempt: id,
    account: id,
    provider: z.literal('chatgpt-subscription'),
    model: z.literal('gpt-6-luna'),
    source_sha256: sha256,
    binary_sha256: sha256,
    expires_unix: count,
    caps: counters,
    retained_baseline: counters,
    old_consumption_proof_sha256: sha256,
    bounds_proof_sha256: sha256,
    hard_output_tokens: count.positive(),
    input_policy: z.literal('TEXT_ONLY_UTF8_BYTES_UPPER_BOUND'),
    output_policy: z.literal('AUTHENTICATED_MODEL_HARD_MAXIMUM_NO_RELEASE'),
    custodian_socket: id,
    journal_id: id,
    custodian_public_key: sha256,
    // Auth Arcana is the identity issuer. A cryptographically verified caller
    // must match this grant; a valid legacy MC/Assistant API key is insufficient.
    caller_subject: id,
    auth_audience: id,
    auth_jwks_sha256: sha256,
    original_ledger_sha256: z.literal(ORIGINAL_LEDGER),
  })
  .strict();
export type Grant = z.infer<typeof grantSchema>;
export const requestSchema = z
  .object({
    schema: z.literal('NativeBenchReservationRequest/v1'),
    campaign: id,
    subject: id,
    attempt: id,
    account: id,
    provider: z.literal('chatgpt-subscription'),
    model: z.literal('gpt-6-luna'),
    source_sha256: sha256,
    binary_sha256: sha256,
    journal_id: id,
    wire_sha256: sha256,
    reserved: counters,
    caps: counters,
    retained_baseline: counters,
    nonce: sha256,
  })
  .strict();
export type ReservationRequest = z.infer<typeof requestSchema>;
export type Head = {
  campaign: string;
  journal: string;
  sequence: number;
  aggregate: number[];
  head: string;
};
export class BenchRefused extends Error {
  constructor(readonly condition: string) {
    super(condition);
  }
}
export function requireBench(condition: unknown, code: string): asserts condition {
  if (!condition) throw new BenchRefused(code);
}
export function checkGrant(grant: Grant, now: number): void {
  requireBench(
    grant.caps.every((v, i) => v === CAPS[i]),
    'original_caps_required',
  );
  requireBench(
    grant.retained_baseline.every((v, i) => v >= FLOOR[i] && v <= CAPS[i]),
    'retained_baseline_required',
  );
  requireBench(grant.expires_unix > now && grant.expires_unix <= now + 3600, 'grant_not_fresh');
  requireBench(
    grant.hard_output_tokens <= CAPS[2] - grant.retained_baseline[2],
    'hard_output_reserve_over_cap',
  );
}
export function bindRequest(grant: Grant, request: ReservationRequest): void {
  for (const key of [
    'campaign',
    'subject',
    'attempt',
    'account',
    'provider',
    'model',
    'source_sha256',
    'binary_sha256',
    'journal_id',
  ] as const) {
    requireBench(grant[key] === request[key], `binding_${key}`);
  }
  requireBench(
    request.caps.every((v, i) => v === CAPS[i]) &&
      request.retained_baseline.every((v, i) => v === grant.retained_baseline[i]),
    'counter_binding',
  );
  requireBench(
    request.reserved[0] === 1 &&
      request.reserved[1] > 0 &&
      request.reserved[2] === grant.hard_output_tokens,
    'actual_send_reservation',
  );
}
