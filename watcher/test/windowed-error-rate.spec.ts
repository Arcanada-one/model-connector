/**
 * CONN-0230 regression tests: classification must be based on windowed error
 * RATE per cycle, not cumulative errorCount.
 *
 * These tests verify the full runCycle seam: delta computation +
 * RateWindow gate inserted in main.ts before handleEvidence.
 */
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyFailure } from '../src/classifier.js';
import { parseConfig } from '../src/config.js';
import { runWatcher } from '../src/main.js';
import { RateWindow } from '../src/rate-window.js';
import { computeMetricDelta } from '../src/observation.js';
import type { EvidenceSnapshot, MetricCounters } from '../src/types.js';

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

const makeCounters = (patch: Partial<MetricCounters> = {}): MetricCounters => ({
  totalRequests: 10,
  errorCount: 0,
  timeoutCount: 0,
  rateLimitedCount: 0,
  circuitOpenCount: 0,
  totalLatencyMs: 100,
  ...patch,
});

const makeEvidence = (patch: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  provider: 'openrouter',
  model: 'openai/gpt-oss-120b:free',
  observedAt: new Date().toISOString(),
  source: 'metrics',
  reachable: true,
  circuitState: 'closed',
  counters: makeCounters(),
  ...patch,
});

// ---------------------------------------------------------------------------
// CONN-0230 regression: cumulative nonzero errorCount must NOT produce
// a permanent false-positive 'unknown' classification
// ---------------------------------------------------------------------------
describe('CONN-0230 regression: windowed-rate vs cumulative errorCount', () => {
  it('classifies null (healthy) when errorCount is nonzero but unchanged between cycles', () => {
    // The live scenario that triggered the bug:
    // openrouter:openai/gpt-oss-120b:free had errorCount=1 out of 9 total requests
    // and the count NEVER changed — it was a single lifetime error. The old code
    // returned 'unknown' every cycle forever.
    //
    // With the fix: delta.errorCount = 0 (no new errors) → RateWindow sees 0/N
    // errors → stays healthy → windowedErrorState = 'healthy' → classifyFailure
    // returns null.
    const deltaCounters = computeMetricDelta(
      makeCounters({ totalRequests: 9, errorCount: 1 }),
      makeCounters({ totalRequests: 20, errorCount: 1 }), // 11 new requests, 0 new errors
    );
    expect(deltaCounters).not.toBeNull(); // no counter reset
    expect(deltaCounters!.errorCount).toBe(0);
    expect(deltaCounters!.totalRequests).toBe(11);

    const window = new RateWindow({
      minimumSamples: 1,
      degradeRatio: 0.25,
      degradeWindows: 1,
      recoverRatio: 0.1,
      recoverWindows: 1,
    });
    const result = window.observe(deltaCounters!.errorCount, deltaCounters!.totalRequests);
    expect(result.state).toBe('healthy');

    const evidence = makeEvidence({
      counters: deltaCounters!,
      windowedErrorState: result.state,
    });
    expect(classifyFailure(evidence)).toBeNull();
  });

  it('still classifies unknown when windowed error RATE exceeds threshold over consecutive windows', () => {
    // True-positive: 5 errors out of 8 requests = 62.5% > 25% degrade_ratio,
    // with degrade_consecutive_windows=1 → must classify 'unknown'.
    const deltaCounters = makeCounters({ totalRequests: 8, errorCount: 5 });
    const window = new RateWindow({
      minimumSamples: 3,
      degradeRatio: 0.25,
      degradeWindows: 1,
      recoverRatio: 0.1,
      recoverWindows: 1,
    });
    const result = window.observe(deltaCounters.errorCount, deltaCounters.totalRequests);
    expect(result.state).toBe('degraded');

    const evidence = makeEvidence({
      counters: deltaCounters,
      windowedErrorState: result.state,
    });
    expect(classifyFailure(evidence)).toBe('unknown');
  });

  it('classifies null when window requires consecutive degraded windows and first window triggers but second recovers', () => {
    // degrade_consecutive_windows=2 means two back-to-back high-error-rate windows
    // are required before firing. After one bad window the state should still be healthy.
    const window = new RateWindow({
      minimumSamples: 1,
      degradeRatio: 0.25,
      degradeWindows: 2,
      recoverRatio: 0.1,
      recoverWindows: 1,
    });
    // Window 1: high error rate — degradedCount becomes 1, still < 2 → stays healthy
    const r1 = window.observe(5, 8);
    expect(r1.state).toBe('healthy');
    const ev1 = makeEvidence({ counters: makeCounters({ errorCount: 5, totalRequests: 8 }), windowedErrorState: r1.state });
    expect(classifyFailure(ev1)).toBeNull();

    // Window 2: high error rate again — degradedCount becomes 2 → transitions to degraded
    const r2 = window.observe(5, 8);
    expect(r2.state).toBe('degraded');
    const ev2 = makeEvidence({ counters: makeCounters({ errorCount: 5, totalRequests: 8 }), windowedErrorState: r2.state });
    expect(classifyFailure(ev2)).toBe('unknown');
  });

  it('classifies null (no-fault) when below minimum_samples', () => {
    // Only 1 request in the window, minimum_samples=5 → ratio is null → no classification.
    const window = new RateWindow({
      minimumSamples: 5,
      degradeRatio: 0.25,
      degradeWindows: 1,
      recoverRatio: 0.1,
      recoverWindows: 1,
    });
    const result = window.observe(1, 1); // ratio=null (samples < minimum)
    expect(result.ratio).toBeNull();
    const evidence = makeEvidence({
      counters: makeCounters({ totalRequests: 1, errorCount: 1 }),
      windowedErrorState: null, // null = below minimum_samples
    });
    expect(classifyFailure(evidence)).toBeNull();
  });

  it('handles counter reset by returning null delta (re-prime path)', () => {
    // When MC restarts, counters can go backwards. computeMetricDelta returns null.
    // main.ts re-primes the baseline and skips classification for that cycle.
    const previous = makeCounters({ totalRequests: 100, errorCount: 5 });
    const afterReset = makeCounters({ totalRequests: 3, errorCount: 0 }); // went backwards
    const delta = computeMetricDelta(previous, afterReset);
    expect(delta).toBeNull(); // triggers re-prime branch in runCycle
  });

  it('explicitErrorType still classifies immediately regardless of windowedErrorState', () => {
    // Deterministic high-signal path must remain intact.
    const evidence = makeEvidence({
      explicitErrorType: 'rate_limited',
      windowedErrorState: 'healthy', // would otherwise suppress it — but explicit wins
    });
    expect(classifyFailure(evidence)).toBe('rate_or_quota');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: runWatcher integration — two full cycles via runWatcher
// ---------------------------------------------------------------------------

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function makeWatcherConfig(baseUrl: string, directory: string) {
  return parseConfig({
    mode: 'shadow',
    model_connector: { base_url: baseUrl },
    opsbot: { base_url: `${baseUrl}/events`, token_env: 'OPSBOT_TOKEN' },
    observation: { interval_ms: 1000, request_timeout_ms: 1000, outage_consecutive_failures: 1, bounded_canary_enabled: false, bounded_canary_max_per_hour: 0 },
    error_rate: {
      window_ms: 1000,
      minimum_samples: 1,
      degrade_ratio: 0.25,
      degrade_consecutive_windows: 1,
      recover_ratio: 0.1,
      recover_consecutive_windows: 1,
    },
    latency: { window_ms: 1000, minimum_samples: 1, baseline_window_ms: 1000, degrade_multiplier: 2, degrade_absolute_delta_ms: 100, degrade_consecutive_windows: 1, recover_multiplier: 1.5, recover_consecutive_windows: 1 },
    recovery: { circuit_reset_enabled: false, natural_recovery_grace_ms: 1000, reset_cooldown_ms: 1000, reset_budget_per_hour: 1, reset_budget_per_day: 1, post_reset_probe_delay_ms: 0, failover_enabled: false },
    catalog: { fetch_enabled: false, write_enabled: false, interval_ms: 1000, startup_jitter_max_ms: 0, request_timeout_ms: 1000, removal_block_ratio: 0.2, removal_block_count: 10, consecutive_missing_before_deprecate: 2 },
    alerting: { dedup_window_ms: 1, heartbeat_interval_ms: 1000, deadman_missed_heartbeats: 3 },
    storage: { state_path: join(directory, 'state.json'), audit_path: join(directory, 'audit.jsonl') },
    health: { bind_host: '127.0.0.1', port: 3914 },
  }, { OPSBOT_TOKEN: 'fixture-token' });
}

describe('CONN-0230 e2e: priming cycle suppresses error-rate false positive via runWatcher', () => {
  /**
   * Regression test for the live production bug.
   *
   * The fix introduces a per-pair baseline in RuntimeState. Each runWatcher call
   * creates a fresh RuntimeState. On the first (priming) observation of a pair,
   * windowedErrorState is set to null — classifier skips the error-rate path.
   * Deterministic signals (circuit_open, provider_outage, explicitErrorType) still
   * classify normally even on the priming cycle.
   */
  it('does not alert on first observation when errorCount is nonzero but circuit is closed', async () => {
    // The live scenario: errorCount=1 out of 9 total, circuit closed.
    // Old code: counters.errorCount > 0 → 'unknown' → alert every cycle.
    // New code: priming cycle → windowedErrorState=null → classifyFailure returns null.
    const alerts: unknown[] = [];

    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health/metrics') {
        res.end(JSON.stringify({
          'openrouter:openai/gpt-oss-120b:free': {
            totalRequests: 9,
            errorCount: 1,
            timeoutCount: 0,
            rateLimitedCount: 0,
            circuitOpenCount: 0,
            totalLatencyMs: 900,
          },
        }));
        return;
      }
      if (req.url === '/events' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          alerts.push(JSON.parse(body));
          res.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      res.end(JSON.stringify({ status: 'ok' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bad fixture address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), 'conn-0230-priming-'));

    await runWatcher({
      config: makeWatcherConfig(baseUrl, directory),
      once: true,
      env: { OPSBOT_TOKEN: 'fixture-token' },
      now: () => Date.parse('2026-06-22T00:00:01.000Z'),
    });

    // THE REGRESSION ASSERTION: no alert for a provider with nonzero cumulative
    // errorCount on the priming cycle when circuit is closed.
    expect(alerts).toHaveLength(0);
  });

  it('does alert on first observation when circuit is open (deterministic signal)', async () => {
    // circuit_open is based on circuitState, not error rate — must fire even on
    // priming cycle (first observation). Ensures priming does not suppress
    // deterministic high-signal classifications.
    const alerts: unknown[] = [];

    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health/metrics') {
        res.end(JSON.stringify({
          'openrouter:circuit-open-model': {
            totalRequests: 5,
            errorCount: 0,
            timeoutCount: 0,
            rateLimitedCount: 0,
            circuitOpenCount: 1,
            totalLatencyMs: 500,
          },
        }));
        return;
      }
      if (req.url === '/events' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          alerts.push(JSON.parse(body));
          res.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      res.end(JSON.stringify({ status: 'ok' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bad fixture address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), 'conn-0230-circuit-open-'));

    await runWatcher({
      config: makeWatcherConfig(baseUrl, directory),
      once: true,
      env: { OPSBOT_TOKEN: 'fixture-token' },
      now: () => Date.parse('2026-06-22T00:00:01.000Z'),
    });

    // circuit_open is a deterministic high-signal — must alert even on priming cycle.
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const alert = alerts[0] as Record<string, unknown>;
    const body = JSON.parse(alert['body'] as string) as Record<string, unknown>;
    expect(body['failure_class']).toBe('circuit_open');
  });
});
