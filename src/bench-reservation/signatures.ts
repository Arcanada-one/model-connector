import { createHash, createPublicKey, sign, verify, KeyObject } from 'node:crypto';
import { z } from 'zod';
import { Grant, requireBench } from './contract';

const envelope = z
  .object({ payload: z.string().max(16384), signature_hex: z.string().regex(/^[a-f0-9]{128}$/) })
  .strict();
export const digest = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  requireBench(encoded !== undefined, 'unserializable_value');
  return encoded;
}
export function publicEd25519(hex: string): KeyObject {
  requireBench(/^[a-f0-9]{64}$/.test(hex), 'invalid_public_key');
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}
export function verifyEnvelope(value: unknown, key: KeyObject, domain: string): string {
  const parsed = envelope.parse(value);
  requireBench(
    key.asymmetricKeyType === 'ed25519' &&
      verify(
        null,
        Buffer.from(domain + parsed.payload),
        key,
        Buffer.from(parsed.signature_hex, 'hex'),
      ),
    'signature_refused',
  );
  return parsed.payload;
}
export function signed(value: unknown, key: KeyObject, domain: string) {
  requireBench(key.asymmetricKeyType === 'ed25519', 'wrong_signer_type');
  const payload = canonical(value);
  return { payload, signature_hex: sign(null, Buffer.from(domain + payload), key).toString('hex') };
}

/** BENCH-specific verification of an Auth Arcana access token. No local JWT secret,
 * token issuer, user table, key issuance or guessed live scope exists here.
 * The fresh root grant binds the independently retrieved Auth Arcana JWKS bytes;
 * future integration must measure actual issuer/audience/scope and key custody.
 */
export function verifyCaller(
  token: string,
  jwksBytes: string,
  grant: Grant,
  now: number,
  requiredScope = 'bench:reserve',
): string {
  requireBench(digest(jwksBytes) === grant.auth_jwks_sha256, 'auth_jwks_not_bound');
  requireBench(token.length <= 16384, 'caller_token_size');
  const parts = token.split('.');
  requireBench(parts.length === 3, 'caller_token_shape');
  const header = z
    .object({ alg: z.literal('RS256'), kid: z.string().min(1), typ: z.literal('JWT').optional() })
    .strict()
    .parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString()));
  const jwks = z
    .object({
      keys: z.array(
        z
          .object({
            kty: z.literal('RSA'),
            kid: z.string(),
            n: z.string(),
            e: z.string(),
            alg: z.literal('RS256').optional(),
            use: z.literal('sig').optional(),
          })
          .strict(),
      ),
    })
    .strict()
    .parse(JSON.parse(jwksBytes));
  const matches = jwks.keys.filter((key) => key.kid === header.kid);
  requireBench(matches.length === 1, 'auth_key_ambiguous');
  const key = createPublicKey({ key: matches[0], format: 'jwk' });
  requireBench(
    verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]),
      key,
      Buffer.from(parts[2], 'base64url'),
    ),
    'caller_signature_refused',
  );
  const claims = z
    .object({
      iss: z.literal('https://auth.arcanada.ai'),
      sub: z.string().min(1),
      aud: z.union([z.string(), z.array(z.string())]),
      exp: z.number().int(),
      iat: z.number().int(),
      nbf: z.number().int().optional(),
      scope: z.string(),
    })
    .passthrough()
    .parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString()));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  requireBench(
    audience.includes(grant.auth_audience) && claims.sub === grant.caller_subject,
    'caller_scope_binding',
  );
  requireBench(
    claims.exp > now &&
      claims.iat <= now &&
      claims.iat >= now - 300 &&
      (claims.nbf === undefined || claims.nbf <= now),
    'caller_not_fresh',
  );
  requireBench(claims.scope.split(' ').includes(requiredScope), 'caller_not_bench_authorized');
  return claims.sub;
}
