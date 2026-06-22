import type { EvidenceSnapshot, FailureClass } from './types.js';

const RATE_ERRORS = new Set(['rate_limited', 'quota_exceeded', 'too_many_requests']);
const AUTH_ERRORS = new Set(['invalid_api_key', 'unauthorized', 'authentication_failed']);
const BILLING_ERRORS = new Set(['insufficient_credits', 'billing_required', 'payment_required']);

export function classifyFailure(evidence: EvidenceSnapshot): FailureClass | null {
  if (!evidence.reachable) return 'provider_outage';
  if (evidence.explicitErrorType && RATE_ERRORS.has(evidence.explicitErrorType)) return 'rate_or_quota';
  if (evidence.explicitErrorType && AUTH_ERRORS.has(evidence.explicitErrorType)) return 'authentication';
  if (evidence.explicitErrorType && BILLING_ERRORS.has(evidence.explicitErrorType)) return 'billing';
  if (evidence.circuitState === 'open' || evidence.counters.circuitOpenCount > 0) return 'circuit_open';
  // Named explicit error types (from health / canary sources) are deterministic — classify immediately.
  if (evidence.explicitErrorType) return 'unknown';
  // For metrics-sourced evidence, use the windowed error rate computed by runCycle.
  // windowedErrorState === undefined means no RateWindow was provided (e.g. health/canary sources
  // that set explicitErrorType but never touch counters). Fall through to null.
  // windowedErrorState === null means below minimum_samples or first-observation priming — not enough
  // data to classify. Do NOT flag.
  if (evidence.windowedErrorState === 'degraded') return 'unknown';
  return null;
}

interface TrackedFailure {
  failureClass: FailureClass | null;
  firstSeenAt?: string;
  currentSeenAt: string;
}

export class FailureTracker {
  private readonly state = new Map<string, TrackedFailure>();

  update(evidence: EvidenceSnapshot): TrackedFailure {
    const key = `${evidence.provider}:${evidence.model}`;
    const failureClass = classifyFailure(evidence);
    const previous = this.state.get(key);
    const next: TrackedFailure = failureClass
      ? {
          failureClass,
          firstSeenAt: previous?.failureClass === failureClass ? previous.firstSeenAt : evidence.observedAt,
          currentSeenAt: evidence.observedAt,
        }
      : { failureClass: null, currentSeenAt: evidence.observedAt };
    this.state.set(key, next);
    return next;
  }
}
