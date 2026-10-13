import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { material, grantEnvelope } from '../../test/bench-reservation/fixture';
import { bindRequest, checkGrant, grantSchema, CAPS } from './contract';
import { verifyEnvelope, verifyCaller, signed, digest } from './signatures';

describe('BENCH signed source authority', () => {
  const f = material('/owned/offline/fixture');
  it('separates real signature domains and rejects a forged/manual grant', () => {
    const value = grantEnvelope(f.grant, f.issuer.privateKey);
    expect(
      grantSchema.parse(JSON.parse(verifyEnvelope(value, f.issuer.publicKey, 'BENCH-GRANT-v1\n'))),
    ).toEqual(f.grant);
    expect(() =>
      verifyEnvelope(value, f.issuer.publicKey, 'BENCH-CUSTODY-RESERVATION-v1\n'),
    ).toThrow();
    expect(() =>
      verifyEnvelope(
        { ...value, payload: value.payload.replace('gpt-6-luna', 'wrong-model') },
        f.issuer.publicKey,
        'BENCH-GRANT-v1\n',
      ),
    ).toThrow();
    expect(() => verifyEnvelope(f.grant, f.issuer.publicKey, 'BENCH-GRANT-v1\n')).toThrow();
  });
  it('cannot widen caps, erase old reserves, or reinterpret a stale grant', () => {
    expect(() => checkGrant({ ...f.grant, caps: [529, CAPS[1], CAPS[2]] }, f.now)).toThrow();
    expect(() => checkGrant({ ...f.grant, retained_baseline: [179, 0, 0] }, f.now)).toThrow();
    expect(() => checkGrant({ ...f.grant, expires_unix: f.now }, f.now)).toThrow();
    expect(() => checkGrant({ ...f.grant, hard_output_tokens: 1_300_090 }, f.now)).toThrow();
  });
  it('requires genuine Auth Arcana signature, exact principal/audience and scope', () => {
    expect(verifyCaller(f.token, f.jwks, f.grant, f.now)).toBe(f.grant.caller_subject);
    for (const delta of [
      { iss: 'https://example.invalid' },
      { sub: 'legacy-assistant' },
      { aud: 'wrong' },
      { scope: 'execute' },
      { exp: f.now },
      { iat: f.now - 301 },
    ]) {
      const body = Buffer.from(JSON.stringify({ ...f.claims, ...delta })).toString('base64url');
      const token = `${f.header}.${body}.${sign('RSA-SHA256', Buffer.from(f.header + '.' + body), f.identity.privateKey).toString('base64url')}`;
      expect(() => verifyCaller(token, f.jwks, f.grant, f.now)).toThrow();
    }
    expect(() => verifyCaller(f.token + 'x', f.jwks, f.grant, f.now)).toThrow();
    expect(() =>
      verifyCaller(f.token, f.jwks, { ...f.grant, auth_jwks_sha256: '0'.repeat(64) }, f.now),
    ).toThrow();
    expect(() => verifyCaller('existing-legacy-api-key', f.jwks, f.grant, f.now)).toThrow();
  });
  it('binds actual account/provider/build/subject/output and rejects substitution', () => {
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
      expect(() => bindRequest(f.grant, { ...f.request, [key]: 'wrong' })).toThrow();
    }
    expect(() => bindRequest(f.grant, { ...f.request, reserved: [1, 30000, 4096] })).toThrow();
    expect(() => bindRequest(f.grant, { ...f.request, reserved: [0, 30000, 128000] })).toThrow();
    expect(() => bindRequest(f.grant, { ...f.request, retained_baseline: [0, 0, 0] })).toThrow();
  });
  it('custodian receipt signature does not become an issuer grant', () => {
    const keys = generateKeyPairSync('ed25519');
    const value = signed(
      { nonce: digest('fixture') },
      keys.privateKey,
      'BENCH-CUSTODY-RESERVATION-v1\n',
    );
    expect(() => verifyEnvelope(value, f.issuer.publicKey, 'BENCH-GRANT-v1\n')).toThrow();
  });
});
