export type FailureClass =
  | 'provider_outage'
  | 'rate_or_quota'
  | 'authentication'
  | 'billing'
  | 'circuit_open'
  | 'unknown';

export interface MetricCounters {
  totalRequests: number;
  errorCount: number;
  timeoutCount: number;
  rateLimitedCount: number;
  circuitOpenCount: number;
  totalLatencyMs: number;
}

export interface EvidenceSnapshot {
  provider: string;
  model: string;
  observedAt: string;
  source: 'health' | 'metrics' | 'bounded_canary';
  reachable: boolean;
  circuitState: 'closed' | 'open' | 'half_open';
  counters: MetricCounters;
  explicitErrorType?: string;
}

export class DependencyUnavailableError extends Error {
  constructor(dependency: 'CONN-0223' | 'CONN-0226') {
    super(`dependency_gate_closed: ${dependency}`);
    this.name = 'DependencyUnavailableError';
  }
}
