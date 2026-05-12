import { Injectable } from '@nestjs/common';

import type { OutputGuardPass } from '../connectors/output-guard/types';

export interface ConnectorMetrics {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  rateLimitedCount: number;
  circuitOpenCount: number;
  queueTimeoutCount: number;
  retryCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  totalQueueWaitMs: number;
  // CONN-0089 — output-guard observability counters
  outputGuardRetries: number;
  outputGuardFinalValid: number;
  outputGuardFinalGuarded: number;
  outputGuardFinalFailed: number;
  outputGuardStrategyCounts: Record<string, number>;
}

function emptyMetrics(): ConnectorMetrics {
  return {
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    timeoutCount: 0,
    rateLimitedCount: 0,
    circuitOpenCount: 0,
    queueTimeoutCount: 0,
    retryCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    totalQueueWaitMs: 0,
    outputGuardRetries: 0,
    outputGuardFinalValid: 0,
    outputGuardFinalGuarded: 0,
    outputGuardFinalFailed: 0,
    outputGuardStrategyCounts: {},
  };
}

@Injectable()
export class MetricsService {
  private metrics = new Map<string, ConnectorMetrics>();

  record(opts: {
    connector: string;
    model?: string;
    status: string;
    errorType?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    queueWaitMs?: number;
    attempt?: number;
    outputGuard?: {
      retries: number;
      finalValid: boolean;
      pass: OutputGuardPass;
      strategiesApplied: string[];
    };
  }) {
    const key = opts.model ? `${opts.connector}:${opts.model}` : opts.connector;
    if (!this.metrics.has(key)) {
      this.metrics.set(key, emptyMetrics());
    }
    const m = this.metrics.get(key)!;
    m.totalRequests++;
    m.totalInputTokens += opts.inputTokens;
    m.totalOutputTokens += opts.outputTokens;
    m.totalCostUsd += opts.costUsd;
    m.totalLatencyMs += opts.latencyMs;
    m.totalQueueWaitMs += opts.queueWaitMs ?? 0;

    if (opts.status === 'success') m.successCount++;
    else if (opts.status === 'timeout') m.timeoutCount++;
    else if (opts.status === 'rate_limited') m.rateLimitedCount++;
    else m.errorCount++;

    if (opts.errorType === 'circuit_open') m.circuitOpenCount++;
    if (opts.errorType === 'queue_timeout') m.queueTimeoutCount++;
    if ((opts.attempt ?? 1) > 1) m.retryCount++;

    if (opts.outputGuard) {
      const og = opts.outputGuard;
      m.outputGuardRetries += og.retries;
      if (og.finalValid) m.outputGuardFinalValid++;
      if (og.pass === 'guarded') m.outputGuardFinalGuarded++;
      if (og.pass === 'failed') m.outputGuardFinalFailed++;
      for (const strategy of og.strategiesApplied) {
        m.outputGuardStrategyCounts[strategy] = (m.outputGuardStrategyCounts[strategy] ?? 0) + 1;
      }
    }
  }

  getAll(): Record<string, ConnectorMetrics & { avgLatencyMs: number }> {
    const result: Record<string, ConnectorMetrics & { avgLatencyMs: number }> = {};
    for (const [name, m] of this.metrics) {
      result[name] = {
        ...m,
        avgLatencyMs: m.totalRequests > 0 ? Math.round(m.totalLatencyMs / m.totalRequests) : 0,
      };
    }
    return result;
  }
}
