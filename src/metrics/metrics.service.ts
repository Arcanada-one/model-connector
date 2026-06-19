import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync, existsSync } from 'fs';

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

// CONN-0102 — STT routing counters (one entry per provider:model, parallel to
// ConnectorMetrics). Kept as a separate map so chat-level avgLatencyMs et al.
// stay untouched.
export interface SttMetrics {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorTypeCounts: Record<string, number>;
  totalAudioDurationSeconds: number;
  totalCostUsd: number;
  totalLatencyMs: number;
}

function emptySttMetrics(): SttMetrics {
  return {
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    errorTypeCounts: {},
    totalAudioDurationSeconds: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
  };
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
  private sttMetrics = new Map<string, SttMetrics>();
  // CONN-0103 — `stt_response_schema_fail_total{provider}` named drift counter.
  private sttSchemaFailCounts: Record<string, number> = {};

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

  // CONN-0102 — STT routing observability.
  recordStt(opts: {
    provider: string;
    model: string;
    status: 'success' | 'error';
    audioDurationSeconds: number;
    costUsd: number;
    latencyMs: number;
    errorType?: string;
  }) {
    const key = `${opts.provider}:${opts.model}`;
    if (!this.sttMetrics.has(key)) {
      this.sttMetrics.set(key, emptySttMetrics());
    }
    const m = this.sttMetrics.get(key)!;
    m.totalRequests++;
    m.totalAudioDurationSeconds += opts.audioDurationSeconds;
    m.totalCostUsd += opts.costUsd;
    m.totalLatencyMs += opts.latencyMs;
    if (opts.status === 'success') m.successCount++;
    else {
      m.errorCount++;
      if (opts.errorType) {
        m.errorTypeCounts[opts.errorType] = (m.errorTypeCounts[opts.errorType] ?? 0) + 1;
      }
    }
  }

  getAllStt(): Record<string, SttMetrics & { avgLatencyMs: number }> {
    const result: Record<string, SttMetrics & { avgLatencyMs: number }> = {};
    for (const [name, m] of this.sttMetrics) {
      result[name] = {
        ...m,
        avgLatencyMs: m.totalRequests > 0 ? Math.round(m.totalLatencyMs / m.totalRequests) : 0,
      };
    }
    return result;
  }

  incrementSttSchemaFail(provider: string): void {
    this.sttSchemaFailCounts[provider] = (this.sttSchemaFailCounts[provider] ?? 0) + 1;
  }

  getSttSchemaFailCounts(): Record<string, number> {
    return { ...this.sttSchemaFailCounts };
  }

  // -------------------------------------------------------------------------
  // Codex OAuth detection counters (CONN-0222 Phase 5)
  // Sidecar-side signals (writeback_failures, refresh_attempts) are
  // incremented by calling code in the sidecar entrypoint or via a sentinel
  // file read path; MC-side signals (refresh_token_reused) are incremented
  // directly in the error classification path.
  // -------------------------------------------------------------------------
  private codexWritebackFailuresTotal = 0;
  private codexRefreshAttemptsTotal = 0;
  private codexRefreshTokenReusedTotal = 0;
  private codexCircuitOpenMsTotal = 0;

  incrementCodexWritebackFailure(): void {
    this.codexWritebackFailuresTotal++;
  }

  incrementCodexRefreshAttempt(): void {
    this.codexRefreshAttemptsTotal++;
  }

  incrementCodexRefreshTokenReused(): void {
    this.codexRefreshTokenReusedTotal++;
  }

  recordCodexCircuitOpenMs(ms: number): void {
    this.codexCircuitOpenMsTotal += ms;
  }

  getCodexWritebackFailureCount(): number {
    return this.codexWritebackFailuresTotal;
  }

  getCodexRefreshAttemptCount(): number {
    return this.codexRefreshAttemptsTotal;
  }

  getCodexRefreshTokenReusedCount(): number {
    return this.codexRefreshTokenReusedTotal;
  }

  getCodexCircuitOpenMs(): number {
    return this.codexCircuitOpenMsTotal;
  }

  getCodexOauthCounters(): {
    vaultWritebackFailuresTotal: number;
    refreshAttemptsTotal: number;
    refreshTokenReusedTotal: number;
    circuitOpenMsTotal: number;
  } {
    return {
      vaultWritebackFailuresTotal: this.codexWritebackFailuresTotal,
      refreshAttemptsTotal: this.codexRefreshAttemptsTotal,
      refreshTokenReusedTotal: this.codexRefreshTokenReusedTotal,
      circuitOpenMsTotal: this.codexCircuitOpenMsTotal,
    };
  }

  // -------------------------------------------------------------------------
  // Sentinel file transport (CONN-0222 detection-metrics).
  // The sidecar writeback script and entrypoint write JSON-lines to
  // ${CODEX_HOME}/.metrics-sentinel when sidecar-observable events occur
  // (writeback_fail, refresh_attempt). This method drains that file
  // atomically (read then truncate) and increments the in-memory counters.
  // Called before generating Prometheus output so the metrics stay current.
  //
  // File format: one JSON object per line, e.g.:
  //   {"event":"writeback_fail"}
  //   {"event":"refresh_attempt"}
  // Unknown events are silently ignored (forward-compatible).
  // -------------------------------------------------------------------------
  drainCodexSentinel(sentinelPath?: string): void {
    const path =
      sentinelPath ?? `${process.env['CODEX_HOME'] ?? '/dev/shm/codex-auth'}/.metrics-sentinel`;
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
      // Truncate atomically after read — any events written between read and
      // truncate are lost (acceptable: sentinel is best-effort, not durable).
      writeFileSync(path, '', 'utf8');
    } catch {
      // Sentinel unreadable / permission denied — fail silently (non-critical path).
      return;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { event?: string };
        if (obj.event === 'writeback_fail') this.codexWritebackFailuresTotal++;
        else if (obj.event === 'refresh_attempt') this.codexRefreshAttemptsTotal++;
      } catch {
        // Malformed line — skip.
      }
    }
  }

  getPrometheusCodexOauth(): string {
    return (
      [
        '# HELP codex_oauth_vault_writeback_failures_total Number of non-CAS Vault writeback failures',
        '# TYPE codex_oauth_vault_writeback_failures_total counter',
        'codex_oauth_vault_writeback_failures_total ' + String(this.codexWritebackFailuresTotal),
        '# HELP codex_oauth_refresh_attempts_total Number of OAuth refresh attempts observed',
        '# TYPE codex_oauth_refresh_attempts_total counter',
        'codex_oauth_refresh_attempts_total ' + String(this.codexRefreshAttemptsTotal),
        '# HELP codex_oauth_refresh_token_reused_total Number of refresh_token_reused errors classified',
        '# TYPE codex_oauth_refresh_token_reused_total counter',
        'codex_oauth_refresh_token_reused_total ' + String(this.codexRefreshTokenReusedTotal),
        '# HELP codex_circuit_open_ms_total Total ms the Codex circuit breaker was open',
        '# TYPE codex_circuit_open_ms_total counter',
        'codex_circuit_open_ms_total ' + String(this.codexCircuitOpenMsTotal),
      ].join('\n') + '\n'
    );
  }
}
