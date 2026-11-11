/**
 * Protected Lab reservation lifecycle (stage A).
 *
 * Versioned so legacy `held` / `released` / `expired` / `completed` rows keep
 * their original meaning. Protected rows use lifecycleVersion = 1 and the
 * phase names below; the legacy `state` column still carries hold accounting
 * (`held` while money is reserved, `completed`/`released`/`expired` once the
 * hold is gone) but reclaim and the sweeper consult the protected phase.
 *
 * Marker: agent-brain-native-reservation-decision-20261108-v1
 *
 * Round 15: phase membership is module-private frozen primitive lists plus
 * explicit predicates. Production paths must not consult any exported mutable
 * collection (`Object.freeze(new Set())` is not sufficient to freeze entries).
 */

import { createHash } from 'node:crypto';

import {
  INTEGRITY_REFUSAL_REASON,
  RESULT_RETENTION,
  type IntegrityRefusalReason,
  verifyProtectedResultIntegrity,
} from './protected-result-integrity';

export const PROTECTED_LIFECYCLE_VERSION = 1 as const;

export const PROTECTED_PHASE = {
  reserved: 'reserved',
  dispatch_committed: 'dispatch_committed',
  unknown: 'unknown',
  settled: 'settled',
  proven_no_dispatch: 'proven_no_dispatch',
} as const;

export type ProtectedPhase = (typeof PROTECTED_PHASE)[keyof typeof PROTECTED_PHASE];

/**
 * Module-private frozen primitive lists. Never exported as a live Set/array
 * that callers can mutate and that production consults.
 */
const PROTECTED_NON_EXPIRE_PHASE_LIST = Object.freeze([
  PROTECTED_PHASE.dispatch_committed,
  PROTECTED_PHASE.unknown,
  PROTECTED_PHASE.settled,
] as const);

const PROTECTED_SETTLEABLE_PHASE_LIST = Object.freeze([
  PROTECTED_PHASE.dispatch_committed,
  PROTECTED_PHASE.unknown,
] as const);

/** Phases the sweeper and reclaim must never treat as abandoned. */
export function isProtectedNonExpirePhase(phase: string | null | undefined): boolean {
  if (phase == null) return false;
  for (const candidate of PROTECTED_NON_EXPIRE_PHASE_LIST) {
    if (candidate === phase) return true;
  }
  return false;
}

/**
 * Fresh frozen copy of settleable phases for the DB `in` predicate.
 * Callers receive a new frozen array each time — mutating one snapshot cannot
 * change later predicates or the private list.
 */
export function protectedSettleablePhases(): readonly ProtectedPhase[] {
  return Object.freeze([...PROTECTED_SETTLEABLE_PHASE_LIST]);
}

/**
 * Fresh frozen diagnostic view of non-expire phases. Production resolve/sweep
 * paths call {@link isProtectedNonExpirePhase}, not this array.
 */
export function protectedNonExpirePhases(): readonly string[] {
  return Object.freeze([...PROTECTED_NON_EXPIRE_PHASE_LIST]);
}

export interface ProtectedReservationBinding {
  apiKeyId: string;
  operationKey: string;
  payloadFingerprint: string;
  providerName: string;
  modelName: string;
  routeKey: string;
  pricePolicyRevision: string;
  holdUsd: string;
  amountUnit: string;
  amountPrecision: number;
  expiresAt: string;
  generation: number;
  protectedPhase: ProtectedPhase;
  lifecycleVersion: typeof PROTECTED_LIFECYCLE_VERSION;
}

export interface ProtectedReservationView extends ProtectedReservationBinding {
  reservationRef: string;
  intentId: string;
  intentKey: string;
}

export class ProtectedProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtectedProfileError';
    this.code = code;
  }
}

/** P9: reserved price/route proof no longer matches at pre-fetch recheck. */
export const PROTECTED_RESERVATION_STALE = 'protected_reservation_stale' as const;

/**
 * Thrown from `__beforeProviderFetch` when the trusted price/route recheck
 * fails. Must not run the dispatch CAS, must not release, and must leave the
 * hold in `reserved` (not `unknown`).
 */
export class ProtectedReservationStaleError extends ProtectedProfileError {
  constructor(message: string) {
    super(PROTECTED_RESERVATION_STALE, message);
    this.name = 'ProtectedReservationStaleError';
  }
}

/** Fields resolveReplay / classification need from a RequestIntent row. */
export interface ProtectedIntentReplayRow {
  state: string;
  lifecycleVersion: number;
  protectedPhase: string | null;
  payloadFingerprint: string;
  operationKey?: string | null;
  response?: unknown;
  requestId?: string | null;
  completedAt?: Date | string | null;
  holdUsd?: unknown;
  intentKey?: string;
  reservationRef?: string | null;
  generation?: number;
  apiKeyId?: string;
  resultIntegrityProfile?: string | null;
  resultIntegrityDigest?: string | null;
  resultRetention?: string | null;
}

/**
 * Stable SHA-256 of a retained settled response. Missing / non-JSON values
 * yield null (treated as a missing retained result hash).
 */
export function retainedProtectedResultHash(response: unknown): string | null {
  if (response === undefined || response === null) return null;
  try {
    const serialised = JSON.stringify(response);
    if (serialised === undefined) return null;
    return createHash('sha256').update(serialised).digest('hex');
  } catch {
    return null;
  }
}

/**
 * P10-05 internal replay classification for a protected lifecycle row.
 *
 * Does not disclose response bytes; callers that still return stored bytes on
 * a legacy HTTP path (no Auth read grant yet) must report that separately.
 */
export type ProtectedReplayClassification =
  | {
      kind: 'nonterminal';
      phase: typeof PROTECTED_PHASE.reserved;
      openOutcome: 'in_flight';
      replayEligible: false;
    }
  | {
      kind: 'nonterminal';
      phase: typeof PROTECTED_PHASE.dispatch_committed | typeof PROTECTED_PHASE.unknown;
      openOutcome: 'protected_unknown';
      replayEligible: false;
    }
  | {
      kind: 'corrupt_settled';
      reason: string;
      openOutcome: 'not_replayable';
      replayEligible: false;
    }
  | {
      kind: 'replay_eligible';
      resultHash: string;
      openOutcome: 'replay';
      replayEligible: true;
      /** Redacted marker only — never the private response body. */
      marker: 'protected_settled_replay_eligible';
    }
  | {
      kind: 'integrity_refused';
      reason: IntegrityRefusalReason;
      openOutcome: 'integrity_refused';
      replayEligible: false;
    }
  | {
      kind: 'proven_no_dispatch';
      openOutcome: 'reclaimable';
      replayEligible: false;
    }
  | {
      kind: 'binding_mismatch';
      openOutcome: 'payload_mismatch';
      replayEligible: false;
    }
  | {
      kind: 'not_protected';
      openOutcome: 'delegate_legacy';
      replayEligible: false;
    };

export function classifyProtectedIntentReplay(params: {
  row: ProtectedIntentReplayRow;
  payloadFingerprint: string;
  /**
   * When set, must equal the row's operationKey / intentKey binding.
   * Production resolveReplay looks the row up by intentKey and passes that
   * same intentKey here, so the check is unreachable on the live path; the
   * effective binding is payloadFingerprint. Kept for defence / unit tests.
   */
  operationKey?: string;
  /**
   * Optional expected retained-result hash (legacy classifier probe).
   * Production resolveReplay does not pass this: integrity is verified from
   * independently retained `result_integrity_*` columns instead.
   */
  expectedResultHash?: string;
}): ProtectedReplayClassification {
  const { row, payloadFingerprint, operationKey, expectedResultHash } = params;

  if (row.lifecycleVersion !== PROTECTED_LIFECYCLE_VERSION || row.protectedPhase == null) {
    return { kind: 'not_protected', openOutcome: 'delegate_legacy', replayEligible: false };
  }

  if (row.payloadFingerprint !== payloadFingerprint) {
    return {
      kind: 'binding_mismatch',
      openOutcome: 'payload_mismatch',
      replayEligible: false,
    };
  }

  if (operationKey !== undefined) {
    const bound = row.operationKey ?? row.intentKey;
    if (bound != null && bound !== operationKey) {
      return {
        kind: 'binding_mismatch',
        openOutcome: 'payload_mismatch',
        replayEligible: false,
      };
    }
  }

  const phase = row.protectedPhase;

  if (phase === PROTECTED_PHASE.reserved) {
    return {
      kind: 'nonterminal',
      phase: PROTECTED_PHASE.reserved,
      openOutcome: 'in_flight',
      replayEligible: false,
    };
  }

  if (phase === PROTECTED_PHASE.dispatch_committed || phase === PROTECTED_PHASE.unknown) {
    return {
      kind: 'nonterminal',
      phase,
      openOutcome: 'protected_unknown',
      replayEligible: false,
    };
  }

  if (phase === PROTECTED_PHASE.proven_no_dispatch) {
    return {
      kind: 'proven_no_dispatch',
      openOutcome: 'reclaimable',
      replayEligible: false,
    };
  }

  if (phase === PROTECTED_PHASE.settled) {
    // Not-retainable settle: charge kept, body absent — honest not_replayable.
    if (row.resultRetention === RESULT_RETENTION.not_retainable) {
      return {
        kind: 'corrupt_settled',
        reason: 'result_not_retainable',
        openOutcome: 'not_replayable',
        replayEligible: false,
      };
    }

    const incomplete = row.state !== 'completed' || row.response == null || row.completedAt == null;

    if (incomplete) {
      return {
        kind: 'corrupt_settled',
        reason: 'missing_settlement_fields_or_result_hash',
        openOutcome: 'not_replayable',
        replayEligible: false,
      };
    }

    const operationBound = row.operationKey ?? row.intentKey;
    const reservationRef = row.reservationRef;
    const apiKeyId = row.apiKeyId;
    const generation = row.generation;

    if (
      operationBound == null ||
      reservationRef == null ||
      apiKeyId == null ||
      generation == null
    ) {
      return {
        kind: 'integrity_refused',
        reason: INTEGRITY_REFUSAL_REASON.integrity_binding_mismatch,
        openOutcome: 'integrity_refused',
        replayEligible: false,
      };
    }

    const verified = verifyProtectedResultIntegrity({
      profile: row.resultIntegrityProfile,
      digest: row.resultIntegrityDigest,
      retention: row.resultRetention,
      binding: {
        operationKey: operationBound,
        apiKeyId,
        payloadFingerprint: row.payloadFingerprint,
        reservationRef,
        settlementGeneration: generation,
      },
      storedResponse: row.response,
    });

    if (!verified.ok) {
      // Never hash-on-read to certify historical rows (integrity_unverified).
      return {
        kind: 'integrity_refused',
        reason: verified.reason,
        openOutcome: 'integrity_refused',
        replayEligible: false,
      };
    }

    const hash = retainedProtectedResultHash(row.response);
    if (hash == null) {
      return {
        kind: 'corrupt_settled',
        reason: 'missing_settlement_fields_or_result_hash',
        openOutcome: 'not_replayable',
        replayEligible: false,
      };
    }

    if (expectedResultHash !== undefined && expectedResultHash !== hash) {
      return {
        kind: 'corrupt_settled',
        reason: 'retained_result_hash_mismatch',
        openOutcome: 'not_replayable',
        replayEligible: false,
      };
    }

    return {
      kind: 'replay_eligible',
      resultHash: verified.digest,
      openOutcome: 'replay',
      replayEligible: true,
      marker: 'protected_settled_replay_eligible',
    };
  }

  // Unknown protected phase string — fail closed, never replay.
  return {
    kind: 'corrupt_settled',
    reason: `unrecognized_protected_phase:${phase}`,
    openOutcome: 'not_replayable',
    replayEligible: false,
  };
}
