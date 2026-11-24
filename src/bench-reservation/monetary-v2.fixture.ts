import { generateKeyPairSync, sign } from 'node:crypto';
import { MonetaryV2Dependencies, monetaryCanonical } from './monetary-v2';
import { CAPS, FLOOR, ORIGINAL_LEDGER } from './contract';
import { canonical, digest, signed } from './signatures';

export function fixture() {
  const issuer = generateKeyPairSync('ed25519');
  const custodian = generateKeyPairSync('ed25519');
  const caller = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let now = 1000;
  const jwks = JSON.stringify({
    keys: [{ ...caller.publicKey.export({ format: 'jwk' }), kid: 'offline' }],
  });
  const scope = {
    campaign: 'offline',
    account: 'account',
    provider: 'chatgpt-subscription',
    model: 'gpt-6-luna',
    source_sha256: '1'.repeat(64),
    binary_sha256: '2'.repeat(64),
    journal_id: 'journal',
    original_ledger_sha256: ORIGINAL_LEDGER,
  };
  let wire = canonical({
    model: 'gpt-6-luna',
    input: 'offline complete input',
  });
  const policy = {
    ...scope,
    kind: 'charging-policy',
    not_before: 990,
    expires: 1100,
    currency: 'USD',
    scale: 100,
    mode: 'metered',
    money_cap: 100,
    money_floor: 30,
    retained_counters: [...FLOOR],
    baseline_head: '6'.repeat(64),
    input_rate: [0, 1],
    output_rate: [0, 1],
    fixed_fee: 1,
    no_overage: true,
    no_fallback: true,
  };
  const bounds = {
    ...scope,
    kind: 'wire-bounds',
    not_before: 990,
    expires: 1100,
    wire_sha256: digest(wire),
    input_upper: Buffer.byteLength(wire),
    output_upper: 128,
    context_limit: 200000,
    output_enforcement: 'verified_native_hard_maximum',
    all_billable_units: true,
  };
  const grant = {
    ...scope,
    schema: 'NativeBenchAdmission/v2',
    accounting_schema: 'NativeBenchAccounting/v2',
    reserved_units: [
      'attempts',
      'qualified_utf8_bytes_input_token_upper_bound_charge',
      'qualified_model_output_token_upper_bound',
    ],
    subject: 'subject',
    attempt: 'attempt',
    expires_unix: 1100,
    caps: [...CAPS],
    retained_baseline: [...FLOOR],
    old_consumption_proof_sha256: '3'.repeat(64),
    bounds_proof_sha256: '4'.repeat(64),
    hard_output_tokens: 128,
    input_policy: 'TEXT_ONLY_UTF8_BYTES_UPPER_BOUND',
    output_policy: 'AUTHENTICATED_MODEL_HARD_MAXIMUM_NO_RELEASE',
    custodian_socket: '/offline/never-listened.sock',
    journal_id: scope.journal_id,
    custodian_public_key: Buffer.from(
      custodian.publicKey.export({ format: 'jwk' }).x!,
      'base64url',
    ).toString('hex'),
    caller_subject: 'caller',
    auth_audience: 'offline-audience',
    auth_jwks_sha256: digest(jwks),
    monetary: {
      schema: 'NativeBenchMonetaryBinding/v1',
      policy_sha256: digest(canonical(policy)),
      bounds_sha256: digest(canonical(bounds)),
      expected_head_sha256: '6'.repeat(64),
    },
  };
  function token() {
    const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
    const raw =
      encode({ alg: 'RS256', kid: 'offline' }) +
      '.' +
      encode({
        iss: 'https://auth.arcanada.ai',
        sub: 'caller',
        aud: 'offline-audience',
        iat: 1000,
        exp: 1100,
        scope: 'bench:reserve',
      });
    return (
      raw + '.' + sign('RSA-SHA256', Buffer.from(raw), caller.privateKey).toString('base64url')
    );
  }
  let calls = 0;
  const deps: MonetaryV2Dependencies = {
    issuerPublicKey: issuer.publicKey,
    custodianPrivateKey: custodian.privateKey,
    authArcanaJwks: jwks,
    now: () => now,
    socketPath: grant.custodian_socket,
    verifyProof: async () => true,
    reserveAtomic: async ({ request, assertFresh }) => {
      assertFresh();
      calls++;
      const m = {
        schema: 'NativeBenchMonetaryReservation/v1',
        request: request.monetary_request,
        currency: 'USD',
        scale: policy.scale,
        cap: policy.money_cap,
        floor: policy.money_floor,
        previous_money: 30,
        cost: 1,
        next_money: 31,
        counters_before: [...FLOOR],
        previous_head_sha256: '6'.repeat(64),
        head_sha256: '7'.repeat(64),
        projection_binding_sha256: '8'.repeat(64),
      };
      m.projection_binding_sha256 = digest(
        monetaryCanonical({
          request: request.monetary_request,
          previous: {
            head: m.previous_head_sha256,
            counters: m.counters_before,
            money: m.previous_money,
            currency: policy.currency,
            scale: policy.scale,
            policy_sha256: request.monetary_request.policy_sha256,
          },
          reserved: request.reserved,
          cost: m.cost,
        }),
      );
      return {
        valid_until_unix: 1005,
        request,
        sequence: 181,
        aggregate: FLOOR.map((n, i) => n + request.reserved[i]),
        previous_head_sha256: m.previous_head_sha256,
        head_sha256: m.head_sha256,
        durable_verdict: 'ATOMIC_FSYNC_RESERVED_UNKNOWN_NO_RELEASE',
        monetary: m,
      };
    },
  };
  const envelope = () => {
    grant.monetary.policy_sha256 = digest(canonical(policy));
    grant.monetary.bounds_sha256 = digest(canonical(bounds));
    const mr = {
      ...scope,
      attempt: grant.attempt,
      nonce: '9'.repeat(64),
      wire_sha256: digest(wire),
      policy_sha256: grant.monetary.policy_sha256,
      bounds_sha256: grant.monetary.bounds_sha256,
    };
    const { original_ledger_sha256: _, ...requestScope } = scope;
    return {
      schema: 'NativeBenchCustodyEnvelope/v2',
      signed_grant: signed(grant, issuer.privateKey, 'BENCH-GRANT-v2\n'),
      caller_access_token: token(),
      operation_deadline_unix: 1005,
      wire_utf8: wire,
      charging_policy_utf8: canonical(policy),
      wire_bounds_utf8: canonical(bounds),
      request: {
        ...requestScope,
        schema: 'NativeBenchReservationRequest/v2',
        subject: grant.subject,
        attempt: grant.attempt,
        nonce: mr.nonce,
        wire_sha256: digest(wire),
        wire_utf8_bytes: Buffer.byteLength(wire),
        input_token_upper_bound: Buffer.byteLength(wire),
        accounting_schema: grant.accounting_schema,
        reserved_units: grant.reserved_units,
        input_policy: grant.input_policy,
        output_policy: grant.output_policy,
        bounds_proof_sha256: grant.bounds_proof_sha256,
        reserved: [1, Buffer.byteLength(wire), 128],
        caps: grant.caps,
        retained_baseline: grant.retained_baseline,
        monetary_request: mr,
        monetary_checkpoint_head_sha256: grant.monetary.expected_head_sha256,
      },
    };
  };
  return {
    deps,
    scope,
    grant,
    policy,
    bounds,
    envelope,
    calls: () => calls,
    advance: () => {
      now = 1006;
    },
    replaceWire: (x: string) => {
      wire = x;
      bounds.wire_sha256 = digest(wire);
      bounds.input_upper = Buffer.byteLength(wire);
    },
  };
}
