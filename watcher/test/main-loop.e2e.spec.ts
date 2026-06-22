import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FailureTracker } from '../src/classifier.js';
import { parseConfig } from '../src/config.js';
import { OpenRouterCatalogAdapter } from '../src/catalog/openrouter.adapter.js';
import { runWatcher } from '../src/main.js';
import { RecoveryPolicy } from '../src/recovery-policy.js';
import type { EvidenceSnapshot } from '../src/types.js';

const servers: Array<ReturnType<typeof createServer>> = [];
const REPAIR_TOKEN = 'x'.repeat(32);

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('watcher main loop e2e', () => {
  it('fetches, classifies, alerts, and gates a conditional repair in one real tick', async () => {
    const requests: string[] = [];
    const alerts: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health/metrics') {
        res.end(JSON.stringify({
          'openrouter:model-a': {
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
      if (req.url === '/catalog') {
        res.end(JSON.stringify({
          data: [{
            id: 'model-a',
            pricing: { prompt: '0', completion: '0' },
            context_length: 4096,
          }],
        }));
        return;
      }
      if (req.url === '/events' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          alerts.push(JSON.parse(body) as Record<string, unknown>);
          res.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      res.end(JSON.stringify(req.url === '/health/connectors'
        ? { status: 'degraded', connectors: [] }
        : { status: 'ok' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), 'conn-0227-main-loop-'));
    const config = createConfig(baseUrl, directory, false);
    const tracker = primedTracker();

    await runWatcher({
      config,
      once: true,
      env: { OPSBOT_TOKEN: 'fixture-token' },
      now: () => Date.parse('2026-06-22T00:00:02.000Z'),
      tracker,
      catalogAdapter: new OpenRouterCatalogAdapter(`${baseUrl}/catalog`),
    });

    expect(requests).toEqual(expect.arrayContaining([
      'GET /health',
      'GET /health/ready',
      'GET /health/metrics',
      'GET /health/connectors',
      'GET /catalog',
      'POST /events',
    ]));
    expect(requests.some((request) => request.includes('/circuit-breaker/reset'))).toBe(false);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert).toMatchObject({
      category: 'info',
      agent: 'model-connector-watcher',
    });
    expect(typeof alert['title']).toBe('string');
    expect((alert['title'] as string).length).toBeLessThanOrEqual(256);
    expect(typeof alert['body']).toBe('string');
    const alertBody = JSON.parse(alert['body'] as string) as Record<string, unknown>;
    expect(alertBody).toMatchObject({
      provider: 'openrouter',
      model: 'model-a',
      failure_class: 'circuit_open',
      attempted_action: 'reset_circuit',
      blocked_action: 'reset_circuit',
      recommended_operator_step: 'enable circuit reset only after activation gates pass',
    });
    expect(JSON.parse(await readFile(config.storage.state_path, 'utf8'))).toMatchObject({
      lastCycleOk: true,
    });
    expect(await readFile(config.storage.audit_path, 'utf8')).toContain('"outcome":"blocked_by_config"');
  });

  it('performs the scoped reset only when the active-mode gate is enabled', async () => {
    const requests: string[] = [];
    let reset = false;
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health/metrics') {
        res.end(JSON.stringify({
          'openrouter:model-a': {
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
      if (req.url === '/internal/watcher/circuit-breaker/reset' && req.method === 'POST') {
        reset = true;
        res.end(JSON.stringify({ reset: [{ connector: 'openrouter', model: 'model-a' }] }));
        return;
      }
      if (req.url === '/health/connectors') {
        res.end(JSON.stringify({ status: reset ? 'ok' : 'degraded', connectors: [] }));
        return;
      }
      if (req.url === '/catalog') {
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.end(JSON.stringify({ status: 'ok' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), 'conn-0227-active-loop-'));

    await runWatcher({
      config: createConfig(baseUrl, directory, true),
      once: true,
      env: { OPSBOT_TOKEN: 'fixture-token', WATCHER_REPAIR_TOKEN: REPAIR_TOKEN },
      now: () => Date.parse('2026-06-22T00:00:02.000Z'),
      tracker: primedTracker(),
      catalogAdapter: new OpenRouterCatalogAdapter(`${baseUrl}/catalog`),
    });

    expect(requests).toEqual(expect.arrayContaining([
      'POST /internal/watcher/circuit-breaker/reset',
      'GET /health/connectors',
    ]));
    expect(await readFile(join(directory, 'audit.jsonl'), 'utf8')).toContain('"fix_applied":true');
  });

  it('alerts when the main-loop repair path is exhausted by cooldown', async () => {
    const requests: string[] = [];
    const alerts: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health/metrics') {
        res.end(JSON.stringify({
          'openrouter:model-a': {
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
          alerts.push(JSON.parse(body) as Record<string, unknown>);
          res.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      if (req.url === '/catalog') {
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.end(JSON.stringify({ status: 'ok' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), 'conn-0227-exhausted-loop-'));
    const now = Date.parse('2026-06-22T00:00:02.000Z');
    const policy = new RecoveryPolicy({
      resetBudgetPerHour: 1,
      resetBudgetPerDay: 1,
      cooldownMs: 1000,
      naturalRecoveryGraceMs: 1000,
    });
    policy.recordReset('openrouter', 'model-a', now - 100);

    await runWatcher({
      config: createConfig(baseUrl, directory, true),
      once: true,
      env: { OPSBOT_TOKEN: 'fixture-token', WATCHER_REPAIR_TOKEN: REPAIR_TOKEN },
      now: () => now,
      tracker: primedTracker(),
      recoveryPolicy: policy,
      catalogAdapter: new OpenRouterCatalogAdapter(`${baseUrl}/catalog`),
    });

    expect(requests.some((request) => request.includes('/circuit-breaker/reset'))).toBe(false);
    expect(alerts).toHaveLength(1);
    const alert2 = alerts[0];
    expect(alert2).toMatchObject({
      category: 'info',
      agent: 'model-connector-watcher',
    });
    const alert2Body = JSON.parse(alert2['body'] as string) as Record<string, unknown>;
    expect(alert2Body).toMatchObject({
      attempted_action: 'reset_circuit',
      blocked_action: 'reset_circuit',
      outcome: 'cooldown',
    });
  });
});

function primedTracker(): FailureTracker {
  const tracker = new FailureTracker();
  const prior: EvidenceSnapshot = {
    provider: 'openrouter',
    model: 'model-a',
    observedAt: '2026-06-22T00:00:00.000Z',
    source: 'metrics',
    reachable: true,
    circuitState: 'open',
    counters: {
      totalRequests: 1,
      errorCount: 0,
      timeoutCount: 0,
      rateLimitedCount: 0,
      circuitOpenCount: 1,
      totalLatencyMs: 100,
    },
  };
  tracker.update(prior);
  return tracker;
}

function createConfig(baseUrl: string, directory: string, circuitResetEnabled: boolean) {
  return parseConfig({
    mode: circuitResetEnabled ? 'active' : 'shadow',
    model_connector: { base_url: baseUrl },
    opsbot: { base_url: `${baseUrl}/events`, token_env: 'OPSBOT_TOKEN' },
    observation: {
      interval_ms: 1000,
      request_timeout_ms: 1000,
      outage_consecutive_failures: 1,
      bounded_canary_enabled: false,
      bounded_canary_max_per_hour: 0,
    },
    error_rate: {
      window_ms: 1000,
      minimum_samples: 1,
      degrade_ratio: 0.25,
      degrade_consecutive_windows: 1,
      recover_ratio: 0.1,
      recover_consecutive_windows: 1,
    },
    latency: {
      window_ms: 1000,
      minimum_samples: 1,
      baseline_window_ms: 1000,
      degrade_multiplier: 2,
      degrade_absolute_delta_ms: 100,
      degrade_consecutive_windows: 1,
      recover_multiplier: 1.5,
      recover_consecutive_windows: 1,
    },
    recovery: {
      circuit_reset_enabled: circuitResetEnabled,
      natural_recovery_grace_ms: 1000,
      reset_cooldown_ms: 1000,
      reset_budget_per_hour: 1,
      reset_budget_per_day: 1,
      post_reset_probe_delay_ms: 0,
      failover_enabled: false,
    },
    catalog: {
      fetch_enabled: true,
      write_enabled: false,
      interval_ms: 1000,
      startup_jitter_max_ms: 0,
      request_timeout_ms: 1000,
      removal_block_ratio: 0.2,
      removal_block_count: 10,
      consecutive_missing_before_deprecate: 2,
    },
    alerting: {
      dedup_window_ms: 1000,
      heartbeat_interval_ms: 1000,
      deadman_missed_heartbeats: 3,
    },
    storage: {
      state_path: join(directory, 'state.json'),
      audit_path: join(directory, 'audit.jsonl'),
    },
    health: { bind_host: '127.0.0.1', port: 3911 },
  }, {
    OPSBOT_TOKEN: 'fixture-token',
    WATCHER_REPAIR_TOKEN: circuitResetEnabled ? REPAIR_TOKEN : undefined,
  });
}
