/**
 * ARAS-0058 — the request INTENT, and the identity a charge is keyed on.
 *
 * The previous ledger key was `request:${created.id}`, where `created.id` was a
 * fresh uuid minted by `prisma.request.create` inside the logging path. That
 * key is unique per ATTEMPT, so it could only ever deduplicate a retry of the
 * settle call itself — something nothing in the system performs. What actually
 * happens in production is a client timeout followed by a re-POST, and against
 * a per-attempt key that is a second provider call and a second charge.
 *
 * An intent key is supplied by the CALLER and identifies the thing they wanted
 * done, not the number of times the wire dropped while they asked for it.
 */

import { createHash } from 'node:crypto';

/** The header callers send. Matches the de-facto industry spelling. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Longest client key we will store. Long enough for a uuid, a ULID, or a
 * hyphen-joined composite; short enough that the unique index stays sane and a
 * caller cannot use the column as free storage.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * How long a hold survives without its owner coming back.
 *
 * A hold is a claim on somebody's money. A process that is SIGKILLed between
 * reserving and settling must not be able to freeze funds indefinitely, so
 * every hold carries an expiry the sweeper can act on. The default is a
 * multiple of the longest connector timeout (600s per the env schema ceiling)
 * so a legitimately slow request is never swept out from under itself.
 */
export const DEFAULT_HOLD_TTL_MS = 30 * 60 * 1000;

/**
 * How long a completed intent stays replayable.
 *
 * Idempotency is a promise with an expiry date; without one the table grows
 * without bound and a key reused a year later silently returns last year's
 * answer. Twenty-four hours matches what callers generally assume.
 */
export const DEFAULT_INTENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Largest response we will store for replay, in bytes of serialised JSON.
 *
 * Past this the intent is marked completed with no stored response and a replay
 * is REFUSED rather than answered. Returning a truncated body under an
 * idempotency key would be worse than refusing: the caller asked for "the same
 * answer as last time" and would get a different one without being told.
 */
export const MAX_REPLAYABLE_RESPONSE_BYTES = 512 * 1024;

export class InvalidIdempotencyKeyError extends Error {
  readonly code = 'invalid_idempotency_key';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyKeyError';
  }
}

/**
 * Validate a caller-supplied idempotency key.
 *
 * Rejects rather than sanitises. A key the caller did not send is not the same
 * key, and quietly rewriting one into something acceptable would make two
 * different intents collide — the precise failure idempotency exists to
 * prevent. Printable ASCII only, so the value cannot smuggle control characters
 * into logs.
 */
export function normalizeIdempotencyKey(raw: unknown): string | null {
  if (raw == null) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new InvalidIdempotencyKeyError(
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  if (!/^[\x21-\x7e]+$/.test(trimmed)) {
    throw new InvalidIdempotencyKeyError('Idempotency-Key must be printable ASCII with no spaces');
  }
  return trimmed;
}

/**
 * The key stored when the caller supplied none.
 *
 * Server-minted and unique, so the hold still has an owner and the expiry sweep
 * still works, while a replay can never match: no key from the caller, no
 * idempotency promise to them. The prefix keeps the two populations
 * distinguishable in the table without a join.
 */
export function mintServerIntentKey(uuid: string): string {
  return `auto:${uuid}`;
}

/**
 * The ledger's idempotency key for an intent's charge.
 *
 * Derived from the intent id rather than the caller's raw key, so a caller
 * cannot choose a value that collides with another account's ledger row — the
 * ledger's unique index is global, while intent keys are only unique per api
 * key.
 */
export function ledgerKeyForIntent(intentId: string): string {
  return `intent:${intentId}`;
}

/** The write-off entry that pairs with an over-budget charge. See schema.prisma. */
export function writeOffKeyForIntent(intentId: string): string {
  return `uncollectible:${intentId}`;
}

/**
 * A stable, non-reversible fingerprint of a request payload.
 *
 * Stripe's rule, and the right one: reusing an idempotency key with a DIFFERENT
 * body is a caller bug, and answering it with the first body would hide the
 * bug behind a correct-looking response. We store the fingerprint so a mismatch
 * can be reported instead.
 */
export function intentPayloadFingerprint(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/** JSON.stringify with deterministic key order, so equal objects hash equal. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
