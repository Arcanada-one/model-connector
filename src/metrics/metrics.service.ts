import { Injectable } from '@nestjs/common';

interface ConnectorMetrics {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  rateLimitedCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
}

@Injectable()
export class MetricsService {
  private metrics = new Map<string, ConnectorMetrics>();

  record(connector: string, status: string, inputTokens: number, outputTokens: number, costUsd: number, latencyMs: number) {
    if (!this.metrics.has(connector)) {
      this.metrics.set(connector, {
        totalRequests: 0, successCount: 0, errorCount: 0,
        timeoutCount: 0, rateLimitedCount: 0,
        totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, totalLatencyMs: 0,
      });
    }
    const m = this.metrics.get(connector)!;
    m.totalRequests++;
    m.totalInputTokens += inputTokens;
    m.totalOutputTokens += outputTokens;
    m.totalCostUsd += costUsd;
    m.totalLatencyMs += latencyMs;

    if (status === 'success') m.successCount++;
    else if (status === 'timeout') m.timeoutCount++;
    else if (status === 'rate_limited') m.rateLimitedCount++;
    else m.errorCount++;
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
