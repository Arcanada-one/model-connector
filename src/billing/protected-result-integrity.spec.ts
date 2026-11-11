/**
 * Unit coverage for pri/v1 integrity + behavioural mutant kills.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  INTEGRITY_REFUSAL_REASON,
  PROTECTED_RESULT_INTEGRITY_PROFILE,
  RESULT_RETENTION,
  computeIntegrityBindingDigest,
  computeProtectedResultIntegrityDigest,
  computeRetainedValueDigest,
  formatIntegrityDigestPair,
  priV1CanonicalJson,
  sealProtectedResultIntegrity,
  verifyProtectedResultIntegrity,
} from './protected-result-integrity';
import { PROTECTED_PHASE, classifyProtectedIntentReplay } from './protected-lifecycle';

const binding = {
  operationKey: 'op-u',
  apiKeyId: 'key-u',
  payloadFingerprint: 'fp-u',
  reservationRef: 'res-u',
  settlementGeneration: 2,
};

describe('pri/v1 canonical + digest', () => {
  it('object key order is equivalent; number vs string differs', () => {
    expect(priV1CanonicalJson({ b: 1, a: 2 })).toBe(priV1CanonicalJson({ a: 2, b: 1 }));
    expect(priV1CanonicalJson({ n: 1 })).not.toBe(priV1CanonicalJson({ n: '1' }));
    expect(priV1CanonicalJson({ u: 'é' })).toContain('é');
  });

  it('seal + verify round-trip', () => {
    const retained = { ok: true, n: null };
    const seal = sealProtectedResultIntegrity({ binding, retained });
    expect(seal.profile).toBe(PROTECTED_RESULT_INTEGRITY_PROFILE);
    expect(seal.retention).toBe(RESULT_RETENTION.retained);
    const verified = verifyProtectedResultIntegrity({
      profile: seal.profile,
      digest: seal.digest,
      retention: seal.retention,
      binding,
      storedResponse: retained,
    });
    expect(verified.ok).toBe(true);
  });

  it('RI02 digest mismatch vs RI03 binding mismatch', () => {
    const retained = { body: 1 };
    const seal = sealProtectedResultIntegrity({ binding, retained });

    const bodyDrift = verifyProtectedResultIntegrity({
      profile: seal.profile,
      digest: seal.digest,
      retention: seal.retention,
      binding,
      storedResponse: { body: 2 },
    });
    expect(bodyDrift).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_digest_mismatch,
    });

    const foreign = sealProtectedResultIntegrity({
      binding: { ...binding, operationKey: 'op-other' },
      retained,
    });
    const bindingDrift = verifyProtectedResultIntegrity({
      profile: seal.profile,
      digest: foreign.digest,
      retention: seal.retention,
      binding,
      storedResponse: retained,
    });
    expect(bindingDrift).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_binding_mismatch,
    });
  });

  it('RI04 typed reasons', () => {
    expect(
      verifyProtectedResultIntegrity({
        profile: null,
        digest: null,
        retention: null,
        binding,
        storedResponse: { a: 1 },
      }),
    ).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_unverified,
    });

    expect(
      verifyProtectedResultIntegrity({
        profile: PROTECTED_RESULT_INTEGRITY_PROFILE,
        digest: null,
        retention: RESULT_RETENTION.retained,
        binding,
        storedResponse: { a: 1 },
      }),
    ).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_digest_missing,
    });

    expect(
      verifyProtectedResultIntegrity({
        profile: PROTECTED_RESULT_INTEGRITY_PROFILE,
        digest: 'zz',
        retention: RESULT_RETENTION.retained,
        binding,
        storedResponse: { a: 1 },
      }),
    ).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_digest_malformed,
    });

    expect(
      verifyProtectedResultIntegrity({
        profile: 'pri/v9',
        digest: formatIntegrityDigestPair('a'.repeat(64), 'b'.repeat(64)),
        retention: RESULT_RETENTION.retained,
        binding,
        storedResponse: { a: 1 },
      }),
    ).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_version_unsupported,
    });
  });
});

describe('classifier integration', () => {
  it('historical settled row is integrity_unverified; sealed row is replay_eligible', () => {
    const retained = { x: 1 };
    const seal = sealProtectedResultIntegrity({ binding, retained });
    const historical = classifyProtectedIntentReplay({
      row: {
        state: 'completed',
        lifecycleVersion: 1,
        protectedPhase: PROTECTED_PHASE.settled,
        payloadFingerprint: binding.payloadFingerprint,
        operationKey: binding.operationKey,
        intentKey: binding.operationKey,
        apiKeyId: binding.apiKeyId,
        reservationRef: binding.reservationRef,
        generation: binding.settlementGeneration,
        response: retained,
        completedAt: new Date(),
      },
      payloadFingerprint: binding.payloadFingerprint,
    });
    expect(historical.kind).toBe('integrity_refused');
    if (historical.kind === 'integrity_refused') {
      expect(historical.reason).toBe(INTEGRITY_REFUSAL_REASON.integrity_unverified);
    }

    const sealed = classifyProtectedIntentReplay({
      row: {
        state: 'completed',
        lifecycleVersion: 1,
        protectedPhase: PROTECTED_PHASE.settled,
        payloadFingerprint: binding.payloadFingerprint,
        operationKey: binding.operationKey,
        intentKey: binding.operationKey,
        apiKeyId: binding.apiKeyId,
        reservationRef: binding.reservationRef,
        generation: binding.settlementGeneration,
        response: retained,
        completedAt: new Date(),
        resultIntegrityProfile: seal.profile,
        resultIntegrityDigest: seal.digest,
        resultRetention: seal.retention,
      },
      payloadFingerprint: binding.payloadFingerprint,
    });
    expect(sealed.kind).toBe('replay_eligible');
  });
});

describe('mutation source anchors (must stay assertion-backed in suite)', () => {
  it('M-RI-NO-COMPARE: verify compares retained digest half', () => {
    const src = readFileSync(path.join(__dirname, 'protected-result-integrity.ts'), 'utf8');
    expect(src).toMatch(/parsed\.retainedDigest !== expectedRetained/);
    const seal = sealProtectedResultIntegrity({ binding, retained: { a: 1 } });
    const bad = verifyProtectedResultIntegrity({
      profile: seal.profile,
      digest: seal.digest,
      retention: seal.retention,
      binding,
      storedResponse: { a: 2 },
    });
    expect(bad).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_digest_mismatch,
    });
  });

  it('M-RI-NO-BINDING: binding digest is part of the sealed pair', () => {
    const retained = { a: 1 };
    const full = computeProtectedResultIntegrityDigest({ binding, retained });
    const retainedOnly = computeRetainedValueDigest(retained);
    expect(full).toContain(':');
    expect(full.endsWith(retainedOnly)).toBe(true);
    expect(full.startsWith(computeIntegrityBindingDigest(binding))).toBe(true);
    // Dropping binding from the digest would make foreign binding verify as ok:
    const foreignBinding = { ...binding, operationKey: 'other' };
    const foreignDigest = formatIntegrityDigestPair(
      computeIntegrityBindingDigest(foreignBinding),
      retainedOnly,
    );
    const refused = verifyProtectedResultIntegrity({
      profile: PROTECTED_RESULT_INTEGRITY_PROFILE,
      digest: foreignDigest,
      retention: RESULT_RETENTION.retained,
      binding,
      storedResponse: retained,
    });
    expect(refused).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_binding_mismatch,
    });
  });

  it('M-RI-NO-VERSION: unsupported profile refuses', () => {
    const seal = sealProtectedResultIntegrity({ binding, retained: { a: 1 } });
    const refused = verifyProtectedResultIntegrity({
      profile: 'pri/v0',
      digest: seal.digest,
      retention: seal.retention,
      binding,
      storedResponse: { a: 1 },
    });
    expect(refused).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_version_unsupported,
    });
  });

  it('M-RI-RESNAPSHOT: settle path seals the storable snapshot written in the same CAS', () => {
    const settleSrc = readFileSync(path.join(__dirname, 'billing.service.ts'), 'utf8');
    // Digest is computed from the local `response` snapshot, inside the
    // protected settle branch, before/with the updateMany that writes it.
    expect(settleSrc).toMatch(/sealProtectedResultIntegrity\(\{[\s\S]*retained: response/);
    expect(settleSrc).toMatch(/\.\.\.integrityData/);
  });

  it('M-RI-NON-ATOMIC / M-RI-LOSER-WRITES: integrity columns are in the CAS updateMany data', () => {
    const settleSrc = readFileSync(path.join(__dirname, 'billing.service.ts'), 'utf8');
    const protectedSettle = settleSrc.slice(
      settleSrc.indexOf('Protected Lab: settle through the versioned phase CAS'),
      settleSrc.indexOf('// The state transition IS the concurrency control'),
    );
    expect(protectedSettle).toMatch(/updateMany/);
    expect(protectedSettle).toMatch(/resultIntegrityDigest/);
    expect(protectedSettle).toMatch(/claimed\.count !== 1\) return false/);
    // Integrity is not written after a failed CAS.
    expect(protectedSettle.indexOf('integrityData')).toBeLessThan(
      protectedSettle.indexOf('claimed.count !== 1'),
    );
  });

  it('M-RI-BACKFILL: verify never assigns a digest on missing metadata', () => {
    const src = readFileSync(path.join(__dirname, 'protected-result-integrity.ts'), 'utf8');
    expect(src).toMatch(/integrity_unverified/);
    expect(src).not.toMatch(/resultIntegrityDigest\s*=/);
    const v = verifyProtectedResultIntegrity({
      profile: null,
      digest: null,
      retention: null,
      binding,
      storedResponse: { a: 1 },
    });
    expect(v).toEqual({
      ok: false,
      reason: INTEGRITY_REFUSAL_REASON.integrity_unverified,
    });
  });
});
