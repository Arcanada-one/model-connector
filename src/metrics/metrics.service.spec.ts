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
