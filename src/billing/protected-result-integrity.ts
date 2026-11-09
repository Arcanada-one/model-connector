/**
 * Protected settled-result integrity profile `pri/v1`.
 *
 * Digests the stored JSON value under a deterministic serialization profile
 * (not wire bytes), bound to settlement identity fields already present on
 * RequestIntent. Metadata is written only inside the winning settlement CAS.
 *
 * Wire form of `result_integrity_digest`:
 *   `<bindingHex>:<retainedHex>`  (each SHA-256 hex, lowercase)
 * so RI02 (retained body drift) and RI03 (binding substitution) stay distinct.
 */

import { createHash } from 'node:crypto';

import { stableJsonStringify } from './intent';

/** Named deterministic profile version stored on retainable settled rows. */
export const PROTECTED_RESULT_INTEGRITY_PROFILE = 'pri/v1' as const;

export type ProtectedResultIntegrityProfile = typeof PROTECTED_RESULT_INTEGRITY_PROFILE;

/** Explicit retention state for protected settled results. */
export const RESULT_RETENTION = {
  retained: 'retained',
  not_retainable: 'not_retainable',
} as const;

export type ResultRetention = (typeof RESULT_RETENTION)[keyof typeof RESULT_RETENTION];

/**
 * Typed no-disclosure refusal reasons for integrity verification failures.
 * Each RI04 variant maps to exactly one of these codes.
 */
export const INTEGRITY_REFUSAL_REASON = {
  integrity_unverified: 'integrity_unverified',
  integrity_digest_missing: 'integrity_digest_missing',
  integrity_digest_malformed: 'integrity_digest_malformed',
  integrity_version_unsupported: 'integrity_version_unsupported',
  integrity_binding_mismatch: 'integrity_binding_mismatch',
  integrity_digest_mismatch: 'integrity_digest_mismatch',
} as const;

export type IntegrityRefusalReason =
  (typeof INTEGRITY_REFUSAL_REASON)[keyof typeof INTEGRITY_REFUSAL_REASON];

const HEX64_RE = /^[0-9a-f]{64}$/;
const DIGEST_PAIR_RE = /^([0-9a-f]{64}):([0-9a-f]{64})$/;

export interface ProtectedResultIntegrityBinding {
  operationKey: string;
  apiKeyId: string;
  payloadFingerprint: string;
  reservationRef: string;
  settlementGeneration: number;
}

export interface ProtectedResultIntegritySeal {
  profile: ProtectedResultIntegrityProfile;
  digest: string;
  retention: typeof RESULT_RETENTION.retained;
}

/**
 * Canonical serialization for `pri/v1`: reuses billing `stableJsonStringify`
 * (sorted object keys, undefined omitted, compact separators).
 */
export function priV1CanonicalJson(value: unknown): string {
  return stableJsonStringify(value);
}

function sha256Hex(canonicalUtf8: string): string {
  return createHash('sha256').update(canonicalUtf8, 'utf8').digest('hex');
}

/** SHA-256 of the stored JSON value under `pri/v1` (not wire bytes). */
export function computeRetainedValueDigest(retained: unknown): string {
  return sha256Hex(priV1CanonicalJson(retained));
}

/**
 * SHA-256 of the settlement binding fields under `pri/v1`.
 * Mutant M-RI-NO-BINDING drops this from the sealed digest pair.
 */
export function computeIntegrityBindingDigest(
  binding: ProtectedResultIntegrityBinding,
  profile: ProtectedResultIntegrityProfile = PROTECTED_RESULT_INTEGRITY_PROFILE,
): string {
  return sha256Hex(
    priV1CanonicalJson({
      profile,
      operationKey: binding.operationKey,
      apiKeyId: binding.apiKeyId,
      payloadFingerprint: binding.payloadFingerprint,
      reservationRef: binding.reservationRef,
      settlementGeneration: binding.settlementGeneration,
    }),
  );
}

export function formatIntegrityDigestPair(bindingDigest: string, retainedDigest: string): string {
  return `${bindingDigest}:${retainedDigest}`;
}

export function parseIntegrityDigestPair(
  value: string,
): { bindingDigest: string; retainedDigest: string } | null {
  const match = DIGEST_PAIR_RE.exec(value);
  if (!match) return null;
  return { bindingDigest: match[1], retainedDigest: match[2] };
}

/**
 * Build the integrity digest for a retainable settled snapshot.
 *
 * `retained` MUST be the same normalized JSON value that will be written to
 * `response` (the `storableResponse` result). Binding fields come from the
 * row identity at settlement; `settlementGeneration` is the post-increment
 * generation that the CAS writes.
 */
export function computeProtectedResultIntegrityDigest(params: {
  binding: ProtectedResultIntegrityBinding;
  retained: unknown;
  profile?: ProtectedResultIntegrityProfile;
}): string {
  const profile = params.profile ?? PROTECTED_RESULT_INTEGRITY_PROFILE;
  return formatIntegrityDigestPair(
    computeIntegrityBindingDigest(params.binding, profile),
    computeRetainedValueDigest(params.retained),
  );
}

export function sealProtectedResultIntegrity(params: {
  binding: ProtectedResultIntegrityBinding;
  retained: unknown;
}): ProtectedResultIntegritySeal {
  return {
    profile: PROTECTED_RESULT_INTEGRITY_PROFILE,
    digest: computeProtectedResultIntegrityDigest(params),
    retention: RESULT_RETENTION.retained,
  };
}

export function isWellFormedIntegrityDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PAIR_RE.test(value);
}

function bindingFieldsComplete(binding: ProtectedResultIntegrityBinding): boolean {
  return (
    typeof binding.operationKey === 'string' &&
    binding.operationKey !== '' &&
    typeof binding.apiKeyId === 'string' &&
    binding.apiKeyId !== '' &&
    typeof binding.payloadFingerprint === 'string' &&
    binding.payloadFingerprint !== '' &&
    typeof binding.reservationRef === 'string' &&
    binding.reservationRef !== '' &&
    typeof binding.settlementGeneration === 'number' &&
    Number.isInteger(binding.settlementGeneration) &&
    binding.settlementGeneration >= 1
  );
}

/**
 * Verify a protected settled row's retained integrity metadata against the
 * current stored JSON value and binding columns. Never backfills a missing
 * digest by hashing on read.
 */
export function verifyProtectedResultIntegrity(params: {
  profile: string | null | undefined;
  digest: string | null | undefined;
  retention: string | null | undefined;
  binding: ProtectedResultIntegrityBinding;
  storedResponse: unknown;
}):
  | { ok: true; digest: string; profile: ProtectedResultIntegrityProfile }
  | { ok: false; reason: IntegrityRefusalReason } {
  const { profile, digest, retention, binding, storedResponse } = params;

  // Historical / pre-change protected settled rows: all integrity columns null.
  if (profile == null && digest == null && retention == null) {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_unverified };
  }

  if (retention === RESULT_RETENTION.not_retainable) {
    // Caller maps this to not_replayable (accounting preserved, no body).
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_digest_missing };
  }

  if (profile == null || profile === '') {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_version_unsupported };
  }
  if (profile !== PROTECTED_RESULT_INTEGRITY_PROFILE) {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_version_unsupported };
  }

  if (digest == null || digest === '') {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_digest_missing };
  }
  const parsed = parseIntegrityDigestPair(digest);
  if (!parsed) {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_digest_malformed };
  }

  if (!bindingFieldsComplete(binding)) {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_binding_mismatch };
  }

  if (storedResponse === undefined || storedResponse === null) {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_digest_missing };
  }

  let expectedBinding: string;
  let expectedRetained: string;
  try {
    expectedBinding = computeIntegrityBindingDigest(binding, PROTECTED_RESULT_INTEGRITY_PROFILE);
    expectedRetained = computeRetainedValueDigest(storedResponse);
  } catch {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_digest_malformed };
  }

  if (parsed.bindingDigest !== expectedBinding) {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_binding_mismatch };
  }
  if (parsed.retainedDigest !== expectedRetained) {
    return { ok: false, reason: INTEGRITY_REFUSAL_REASON.integrity_digest_mismatch };
  }

  return {
    ok: true,
    digest: formatIntegrityDigestPair(expectedBinding, expectedRetained),
    profile: PROTECTED_RESULT_INTEGRITY_PROFILE,
  };
}

/** Exported for mutant/unit probes — hex64 shape check. */
export function isHex64(value: string): boolean {
  return HEX64_RE.test(value);
}
