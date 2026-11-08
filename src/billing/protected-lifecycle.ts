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
 */

export const PROTECTED_LIFECYCLE_VERSION = 1 as const;

export const PROTECTED_PHASE = {
  reserved: 'reserved',
  dispatch_committed: 'dispatch_committed',
  unknown: 'unknown',
  settled: 'settled',
  proven_no_dispatch: 'proven_no_dispatch',
} as const;

export type ProtectedPhase = (typeof PROTECTED_PHASE)[keyof typeof PROTECTED_PHASE];

/** Phases the sweeper and reclaim must never touch. */
export const PROTECTED_NON_EXPIRE_PHASES: ReadonlySet<string> = new Set([
  PROTECTED_PHASE.dispatch_committed,
  PROTECTED_PHASE.unknown,
  PROTECTED_PHASE.settled,
]);

/** Phases from which a late result may still settle exactly once. */
export const PROTECTED_SETTLEABLE_PHASES: ReadonlyArray<ProtectedPhase> = [
  PROTECTED_PHASE.dispatch_committed,
  PROTECTED_PHASE.unknown,
];

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
