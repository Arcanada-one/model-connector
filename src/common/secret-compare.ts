import { createHash, timingSafeEqual } from 'crypto';

/**
 * ARAS-0058 (consilium §6.2) — compare a caller-supplied secret against an
 * expected one without leaking anything, and without being able to throw.
 *
 * The defect this replaces: `AdminGuard` compared `token.length !==
 * expected.length` and then `timingSafeEqual(Buffer.from(token),
 * Buffer.from(expected))`. `String.length` counts UTF-16 code units;
 * `Buffer.from` encodes UTF-8 bytes. A token containing a multi-byte character
 * at the SAME string length as the secret passes the pre-check and reaches
 * `timingSafeEqual` with buffers of different byte lengths, which throws
 * `RangeError`. Nest turns that into a 500 while every other wrong token gets
 * a 403 — a distinguishable response that reports the secret's BYTE length,
 * one probe at a time. `StatsReadGuard` says in its own header that it was
 * "Modeled on" that guard, so the defect had already propagated once before
 * anyone noticed; the fix is a shared primitive rather than a third copy of
 * the same five lines.
 *
 * Hashing first is what makes it safe rather than merely correct:
 *
 *  - both digests are 32 bytes whatever the inputs were, so `timingSafeEqual`
 *    can never see a length mismatch and can never throw. There is no
 *    throwing pre-check left to remove because there is no pre-check.
 *  - the length check is gone entirely, so a wrong-length token takes exactly
 *    the same path as a wrong-value one. The old guard answered "is your token
 *    the right length?" for free, before comparing anything.
 *  - SHA-256 over a secret of arbitrary length is constant work, and the
 *    comparison of the digests is constant time.
 *
 * This is deliberately NOT a KDF: both sides are high-entropy secrets held in
 * the environment, not user passwords, so the property needed is a fixed-width
 * constant-time comparison, not brute-force resistance.
 */
export function secretsMatch(supplied: string, expected: string): boolean {
  // Fail closed on the empty string rather than hashing it: an unset
  // environment variable read as `''` must never authenticate a caller who
  // also sends `''`.
  if (!supplied || !expected) return false;

  return timingSafeEqual(digest(supplied), digest(expected));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
