import { describe, expect, it } from 'vitest';
import { classifyFailure, FailureTracker } from '../src/classifier.js';
import { computeMetricDelta } from '../src/observation.js';
import type { EvidenceSnapshot } from '../src/types.js';

const evidence = (patch: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  provider: 'openrouter',
  model: 'model-a',
  observedAt: '2026-01-01T00:00:00.000Z',
  source: 'health',
  reachable: true,
  circuitState: 'closed',
  counters: {
    totalRequests: 10,
    errorCount: 0,
    timeoutCount: 0,
    rateLimitedCount: 0,
    circuitOpenCount: 0,
    totalLatencyMs: 100,
  },
  ...patch,
});

describe('deterministic failure detection', () => {
  it.each([
    [{ reachable: false }, 'provider_outage'],
    [{ explicitErrorType: 'rate_limited' }, 'rate_or_quota'],
    [{ explicitErrorType: 'invalid_api_key' }, 'authentication'],
    [{ explicitErrorType: 'insufficient_credits' }, 'billing'],
    [{ circuitState: 'open' }, 'circuit_open'],
    [{ explicitErrorType: 'weird' }, 'unknown'],
  ] as const)('classifies priority-ordered evidence', (patch, expected) => {
    expect(classifyFailure(evidence(patch))).toBe(expected);
  });

  it('tracks first-seen until recovery', () => {
    const tracker = new FailureTracker();
    const first = tracker.update(evidence({ circuitState: 'open' }));
    const second = tracker.update(evidence({ circuitState: 'open', observedAt: '2026-01-01T00:01:00.000Z' }));
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(tracker.update(evidence()).failureClass).toBeNull();
  });

  it('treats counter restart as a new baseline', () => {
    expect(computeMetricDelta(evidence().counters, evidence({ counters: { ...evidence().counters, totalRequests: 2 } }).counters)).toBeNull();
  });
});
