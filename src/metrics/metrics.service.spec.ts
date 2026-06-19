import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService — STT extension (CONN-0102)', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('records success — increments totals and successCount', () => {
    metrics.recordStt({
      provider: 'groq',
      model: 'whisper-large-v3',
      status: 'success',
      audioDurationSeconds: 13.7,
      costUsd: 0.000423,
      latencyMs: 1331,
    });
    const all = metrics.getAllStt();
    expect(all['groq:whisper-large-v3'].totalRequests).toBe(1);
    expect(all['groq:whisper-large-v3'].successCount).toBe(1);
    expect(all['groq:whisper-large-v3'].errorCount).toBe(0);
    expect(all['groq:whisper-large-v3'].totalAudioDurationSeconds).toBeCloseTo(13.7);
    expect(all['groq:whisper-large-v3'].totalCostUsd).toBeCloseTo(0.000423);
    expect(all['groq:whisper-large-v3'].avgLatencyMs).toBe(1331);
  });

  it('records error — increments errorTypeCounts', () => {
    metrics.recordStt({
      provider: 'groq',
      model: 'whisper-large-v3',
      status: 'error',
      audioDurationSeconds: 0,
      costUsd: 0,
      latencyMs: 800,
      errorType: 'auth_failed',
    });
    metrics.recordStt({
      provider: 'groq',
      model: 'whisper-large-v3',
      status: 'error',
      audioDurationSeconds: 0,
      costUsd: 0,
      latencyMs: 1000,
      errorType: 'auth_failed',
    });
    const all = metrics.getAllStt();
    expect(all['groq:whisper-large-v3'].errorCount).toBe(2);
    expect(all['groq:whisper-large-v3'].errorTypeCounts.auth_failed).toBe(2);
    expect(all['groq:whisper-large-v3'].successCount).toBe(0);
  });

  it('separates buckets per provider:model', () => {
    metrics.recordStt({
      provider: 'groq',
      model: 'whisper-large-v3',
      status: 'success',
      audioDurationSeconds: 1,
      costUsd: 0.00003,
      latencyMs: 100,
    });
    metrics.recordStt({
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      status: 'success',
      audioDurationSeconds: 1,
      costUsd: 0.00002,
      latencyMs: 50,
    });
    const all = metrics.getAllStt();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['groq:whisper-large-v3'].totalRequests).toBe(1);
    expect(all['groq:whisper-large-v3-turbo'].totalRequests).toBe(1);
  });

  it('chat-level metrics remain unaffected when only STT is recorded', () => {
    metrics.recordStt({
      provider: 'groq',
      model: 'whisper-large-v3',
      status: 'success',
      audioDurationSeconds: 1,
      costUsd: 0,
      latencyMs: 100,
    });
    expect(metrics.getAll()).toEqual({});
  });
});

// CONN-0103 remediation — named drift counter (stt_response_schema_fail_total{provider}).
describe('MetricsService — STT drift counter (CONN-0103)', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('incrementSttSchemaFail increments per-provider counter', () => {
    metrics.incrementSttSchemaFail('deepgram');
    metrics.incrementSttSchemaFail('deepgram');
    metrics.incrementSttSchemaFail('assemblyai');
    expect(metrics.getSttSchemaFailCounts()).toEqual({
      deepgram: 2,
      assemblyai: 1,
    });
  });

  it('getSttSchemaFailCounts returns empty record when no drift recorded', () => {
    expect(metrics.getSttSchemaFailCounts()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// D-1..D-4: Codex OAuth detection metrics (CONN-0222 Phase 5)
// ---------------------------------------------------------------------------
describe('MetricsService — Codex OAuth detection counters (CONN-0222)', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  // D-1a: writeback failure counter increments
  it('D-1a: incrementCodexWritebackFailure increments per call', () => {
    metrics.incrementCodexWritebackFailure();
    metrics.incrementCodexWritebackFailure();
    expect(metrics.getCodexWritebackFailureCount()).toBe(2);
  });

  // D-1b: refresh_token_reused detection counter increments
  it('D-1b: incrementCodexRefreshTokenReused increments per call', () => {
    metrics.incrementCodexRefreshTokenReused();
    expect(metrics.getCodexRefreshTokenReusedCount()).toBe(1);
  });

  // D-1c: refresh attempt counter increments
  it('D-1c: incrementCodexRefreshAttempt increments per call', () => {
    metrics.incrementCodexRefreshAttempt();
    metrics.incrementCodexRefreshAttempt();
    metrics.incrementCodexRefreshAttempt();
    expect(metrics.getCodexRefreshAttemptCount()).toBe(3);
  });

  // D-1d: counters start at zero
  it('D-1d: all Codex OAuth counters start at zero', () => {
    expect(metrics.getCodexWritebackFailureCount()).toBe(0);
    expect(metrics.getCodexRefreshTokenReusedCount()).toBe(0);
    expect(metrics.getCodexRefreshAttemptCount()).toBe(0);
  });

  // D-2: getCodexOauthCounters returns all four signals
  it('D-2: getCodexOauthCounters returns all four counters', () => {
    metrics.incrementCodexWritebackFailure();
    metrics.incrementCodexRefreshAttempt();
    metrics.incrementCodexRefreshAttempt();
    metrics.incrementCodexRefreshTokenReused();
    const counters = metrics.getCodexOauthCounters();
    expect(counters.vaultWritebackFailuresTotal).toBe(1);
    expect(counters.refreshAttemptsTotal).toBe(2);
    expect(counters.refreshTokenReusedTotal).toBe(1);
  });

  // D-3: CB-state seconds tracking
  it('D-3: recordCodexCircuitOpenMs accumulates milliseconds', () => {
    metrics.recordCodexCircuitOpenMs(5000);
    metrics.recordCodexCircuitOpenMs(3000);
    expect(metrics.getCodexCircuitOpenMs()).toBe(8000);
  });

  it('D-3b: CB open ms starts at zero', () => {
    expect(metrics.getCodexCircuitOpenMs()).toBe(0);
  });

  // D-4: getPrometheusCodexOauth returns Prometheus text with all series
  it('D-4: getPrometheusCodexOauth includes all four metric series names', () => {
    metrics.incrementCodexWritebackFailure();
    metrics.incrementCodexRefreshAttempt();
    metrics.incrementCodexRefreshTokenReused();
    metrics.recordCodexCircuitOpenMs(1000);
    const text = metrics.getPrometheusCodexOauth();
    expect(text).toContain('codex_oauth_vault_writeback_failures_total');
    expect(text).toContain('codex_oauth_refresh_attempts_total');
    expect(text).toContain('codex_oauth_refresh_token_reused_total');
    expect(text).toContain('codex_circuit_open_ms_total');
  });
});

// ---------------------------------------------------------------------------
// D-5..D-7: drainCodexSentinel — sentinel file transport (CONN-0222 round 3)
// ---------------------------------------------------------------------------
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MetricsService — drainCodexSentinel', () => {
  let metrics: MetricsService;
  let tmpDir: string;
  let sentinelPath: string;

  beforeEach(() => {
    metrics = new MetricsService();
    tmpDir = mkdtempSync(join(tmpdir(), 'conn-0222-sentinel-'));
    sentinelPath = join(tmpDir, '.metrics-sentinel');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // D-5: writeback_fail events increment writeback failure counter
  it('D-5: writeback_fail lines increment codexWritebackFailuresTotal', () => {
    writeFileSync(sentinelPath, '{"event":"writeback_fail"}\n{"event":"writeback_fail"}\n');
    metrics.drainCodexSentinel(sentinelPath);
    expect(metrics.getCodexWritebackFailureCount()).toBe(2);
    // File must be truncated after drain
    expect(readFileSync(sentinelPath, 'utf8')).toBe('');
  });

  // D-6: refresh_attempt events increment refresh attempt counter
  it('D-6: refresh_attempt lines increment codexRefreshAttemptsTotal', () => {
    writeFileSync(sentinelPath, '{"event":"refresh_attempt"}\n');
    metrics.drainCodexSentinel(sentinelPath);
    expect(metrics.getCodexRefreshAttemptCount()).toBe(1);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('');
  });

  // D-7: mixed events, unknown events ignored, file absent is no-op
  it('D-7: mixed events processed; unknown events silently ignored', () => {
    writeFileSync(
      sentinelPath,
      '{"event":"refresh_attempt"}\n{"event":"unknown_future_event"}\n{"event":"writeback_fail"}\n',
    );
    metrics.drainCodexSentinel(sentinelPath);
    expect(metrics.getCodexRefreshAttemptCount()).toBe(1);
    expect(metrics.getCodexWritebackFailureCount()).toBe(1);
    expect(metrics.getCodexRefreshTokenReusedCount()).toBe(0);
  });

  it('D-7b: absent sentinel file is a no-op (no error thrown)', () => {
    // sentinelPath does not exist
    expect(() => metrics.drainCodexSentinel(sentinelPath)).not.toThrow();
    expect(metrics.getCodexWritebackFailureCount()).toBe(0);
    expect(metrics.getCodexRefreshAttemptCount()).toBe(0);
  });

  it('D-7c: malformed JSON lines are silently skipped', () => {
    writeFileSync(
      sentinelPath,
      '{"event":"refresh_attempt"}\nnot-json\n{"event":"writeback_fail"}\n',
    );
    metrics.drainCodexSentinel(sentinelPath);
    expect(metrics.getCodexRefreshAttemptCount()).toBe(1);
    expect(metrics.getCodexWritebackFailureCount()).toBe(1);
  });
});
