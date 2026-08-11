import type { EvidenceSnapshot, MetricCounters } from './types.js';

export function computeMetricDelta(previous: MetricCounters, current: MetricCounters): MetricCounters | null {
  const keys = Object.keys(previous) as Array<keyof MetricCounters>;
  if (keys.some((key) => current[key] < previous[key])) return null;
  return Object.fromEntries(keys.map((key) => [key, current[key] - previous[key]])) as unknown as MetricCounters;
}

export function normalizeMetrics(metrics: Record<string, MetricCounters>, observedAt = new Date().toISOString()): EvidenceSnapshot[] {
  return Object.entries(metrics).map(([key, counters]) => {
    const separator = key.indexOf(':');
    const provider = separator === -1 ? key : key.slice(0, separator);
    const model = separator === -1 ? 'unknown' : key.slice(separator + 1);
    return {
      provider,
      model,
      observedAt,
      source: 'metrics',
      reachable: true,
      circuitState: counters.circuitOpenCount > 0 ? 'open' : 'closed',
      counters,
    };
  });
}
