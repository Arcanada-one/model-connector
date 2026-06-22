import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deadman } from '../src/deadman.js';
import { OpsBotClient, redact } from '../src/opsbot.client.js';
import { FailureTracker } from '../src/classifier.js';
import { parseConfig } from '../src/config.js';
import { OpenRouterCatalogAdapter } from '../src/catalog/openrouter.adapter.js';
import { runWatcher } from '../src/main.js';
import type { EvidenceSnapshot } from '../src/types.js';

// Inline equivalent of CreateEventDto validation.
// Source of truth: Projects/Ops Bot/code/opsbot/src/modules/events/dto/create-event.dto.ts
// Not importable here (separate repo/workspace).
// Full 7-value enum as verified on deployed prod container /app/dist/modules/events/dto/create-event.dto.js (2026-06-22).
const EVENT_CATEGORIES = new Set(['fatal', 'warning', 'approval', 'digest', 'info', 'heartbeat', 'feedback']);
function validateCreateEventDto(event: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!event || typeof event !== 'object') return { ok: false, error: 'not an object' };
  const e = event as Record<string, unknown>;
  if (!EVENT_CATEGORIES.has(e['category'] as string)) return { ok: false, error: `invalid category: ${String(e['category'])}` };
  if (typeof e['agent'] !== 'string' || e['agent'].length < 1 || e['agent'].length > 128) return { ok: false, error: `invalid agent: ${String(e['agent'])}` };
  if (typeof e['title'] !== 'string' || e['title'].length < 1 || e['title'].length > 256) return { ok: false, error: `invalid title length: ${(e['title'] as string).length}` };
  if (typeof e['body'] !== 'string' || e['body'].length > 4000) return { ok: false, error: `invalid body length: ${(e['body'] as string)?.length}` };
  if (e['dedup_key'] !== undefined && (typeof e['dedup_key'] !== 'string' || e['dedup_key'].length > 128)) return { ok: false, error: `invalid dedup_key` };
  return { ok: true, data: e };
}

const servers: Array<ReturnType<typeof createServer>> = [];
const REPAIR_TOKEN = 'x'.repeat(32);

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('alerting and independent deadman', () => {
  it('recursively redacts secrets and truncates error text', () => {
    const value = redact({ token: 'secret', nested: { authorization: 'bearer', message: 'x'.repeat(300) } });
    expect(JSON.stringify(value)).not.toContain('secret');
    expect((value as { nested: { message: string } }).nested.message.length).toBe(200);
  });

  it('deduplicates identical alerts', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = new OpsBotClient(send, 900000);
    const event = { provider: 'p', model: 'm', failure_class: 'unknown', audit_ref: 'a' };
    await client.emit(event, 1);
    await client.emit(event, 2);
    expect(send).toHaveBeenCalledOnce();
  });

  it('alerts after three missed heartbeats without recovery imports', async () => {
    const alert = vi.fn().mockResolvedValue(undefined);
    const deadman = new Deadman(30000, 3, alert);
    expect(await deadman.check('2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:02:00.000Z'))).toBe(true);
    expect(alert).toHaveBeenCalledOnce();
  });

  it('detection emit conforms to canonical CreateEventDto shape, category warning-when-blocked info-when-not', async () => {
    // Drives the real handleEvidence -> emitAlert code path via runWatcher.
    // Captures the event POSTed to the Ops Bot endpoint and validates it
    // against the canonical CreateEventDto schema (inline equivalent of
    // Projects/Ops Bot/code/opsbot/src/modules/events/dto/create-event.dto.ts).
    const captured: unknown[] = [];
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health/metrics') {
        res.end(JSON.stringify({
          'openrouter:test-model': {
            totalRequests: 5, errorCount: 0, timeoutCount: 0,
            rateLimitedCount: 0, circuitOpenCount: 1, totalLatencyMs: 500,
          },
        }));
        return;
      }
      if (req.url === '/events' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          captured.push(JSON.parse(body));
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
    const directory = await mkdtemp(join(tmpdir(), 'conn-0230-emit-shape-'));

    const tracker = new FailureTracker();
    const prior: EvidenceSnapshot = {
      provider: 'openrouter', model: 'test-model',
      observedAt: '2026-06-22T00:00:00.000Z', source: 'metrics', reachable: true,
      circuitState: 'open',
      counters: { totalRequests: 1, errorCount: 0, timeoutCount: 0, rateLimitedCount: 0, circuitOpenCount: 1, totalLatencyMs: 100 },
    };
    tracker.update(prior);

    await runWatcher({
      config: parseConfig({
        mode: 'shadow',
        model_connector: { base_url: baseUrl },
        opsbot: { base_url: `${baseUrl}/events`, token_env: 'OPSBOT_TOKEN' },
        observation: { interval_ms: 1000, request_timeout_ms: 1000, outage_consecutive_failures: 1, bounded_canary_enabled: false, bounded_canary_max_per_hour: 0 },
        error_rate: { window_ms: 1000, minimum_samples: 1, degrade_ratio: 0.25, degrade_consecutive_windows: 1, recover_ratio: 0.1, recover_consecutive_windows: 1 },
        latency: { window_ms: 1000, minimum_samples: 1, baseline_window_ms: 1000, degrade_multiplier: 2, degrade_absolute_delta_ms: 100, degrade_consecutive_windows: 1, recover_multiplier: 1.5, recover_consecutive_windows: 1 },
        recovery: { circuit_reset_enabled: false, natural_recovery_grace_ms: 1000, reset_cooldown_ms: 1000, reset_budget_per_hour: 1, reset_budget_per_day: 1, post_reset_probe_delay_ms: 0, failover_enabled: false },
        catalog: { fetch_enabled: true, write_enabled: false, interval_ms: 1000, startup_jitter_max_ms: 0, request_timeout_ms: 1000, removal_block_ratio: 0.2, removal_block_count: 10, consecutive_missing_before_deprecate: 2 },
        alerting: { dedup_window_ms: 1000, heartbeat_interval_ms: 1000, deadman_missed_heartbeats: 3 },
        storage: { state_path: join(directory, 'state.json'), audit_path: join(directory, 'audit.jsonl') },
        health: { bind_host: '127.0.0.1', port: 3912 },
      }, { OPSBOT_TOKEN: 'fixture-token' }),
      once: true,
      env: { OPSBOT_TOKEN: 'fixture-token' },
      now: () => Date.parse('2026-06-22T00:00:02.000Z'),
      tracker,
      catalogAdapter: new OpenRouterCatalogAdapter(`${baseUrl}/catalog`),
    });

    expect(captured).toHaveLength(1);
    const event = captured[0];

    // Assert canonical CreateEventDto shape
    // validates against the full 7-value enum
    const result = validateCreateEventDto(event);
    expect(result.ok, result.ok ? '' : (result as { ok: false; error: string }).error).toBe(true);

    const e = event as Record<string, unknown>;
    // category must be 'warning' when action is blocked (shadow mode blocks reset_circuit)
    // and 'info' when no action is blocked. Both branches covered: blocked path here.
    expect(e['category']).toBe('warning');
    expect(e['agent']).toBe('model-connector-watcher');
    expect(typeof e['title']).toBe('string');
    expect((e['title'] as string).length).toBeLessThanOrEqual(256);
    expect(typeof e['body']).toBe('string');
    expect((e['body'] as string).length).toBeLessThanOrEqual(4000);

    // body must JSON-parse back to an object containing the detail fields
    const bodyParsed = JSON.parse(e['body'] as string) as Record<string, unknown>;
    expect(bodyParsed['provider']).toBe('openrouter');
    expect(bodyParsed['model']).toBe('test-model');
    expect(typeof bodyParsed['failure_class']).toBe('string');
    expect(typeof bodyParsed['audit_ref']).toBe('string');

    // dedup_key must be present and ≤128
    expect(typeof e['dedup_key']).toBe('string');
    expect((e['dedup_key'] as string).length).toBeLessThanOrEqual(128);
  });
  it('detection emit yields category info when action is not blocked', async () => {
    // Non-blocked path: circuit_reset_enabled=true means executeRecovery runs,
    // blockedAction is undefined -> category: blockedAction ? 'warning' : 'info' = 'info'.
    const captured: unknown[] = [];
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health/metrics') {
        res.end(JSON.stringify({
          'openrouter:test-model': {
            totalRequests: 5, errorCount: 0, timeoutCount: 0,
            rateLimitedCount: 0, circuitOpenCount: 1, totalLatencyMs: 500,
          },
        }));
        return;
      }
      if (req.url === '/events' && req.method === 'POST') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          captured.push(JSON.parse(body));
          res.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      // Reset-circuit repair endpoint
      if (req.method === 'POST' && req.url && req.url.includes('reset-circuit')) {
        res.end(JSON.stringify({ reset: true }));
        return;
      }
      if (req.url === '/catalog') { res.end(JSON.stringify({ data: [] })); return; }
      res.end(JSON.stringify({ status: 'ok' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(join(tmpdir(), 'conn-0230-nonblocked-'));

    const tracker = new FailureTracker();
    const prior: EvidenceSnapshot = {
      provider: 'openrouter', model: 'test-model',
      observedAt: '2026-06-22T00:00:00.000Z', source: 'metrics', reachable: true,
      circuitState: 'open',
      counters: { totalRequests: 1, errorCount: 0, timeoutCount: 0, rateLimitedCount: 0, circuitOpenCount: 1, totalLatencyMs: 100 },
    };
    tracker.update(prior);

    await runWatcher({
      config: parseConfig({
        mode: 'active',
        model_connector: { base_url: baseUrl },
        opsbot: { base_url: `${baseUrl}/events`, token_env: 'OPSBOT_TOKEN' },
        observation: { interval_ms: 1000, request_timeout_ms: 1000, outage_consecutive_failures: 1, bounded_canary_enabled: false, bounded_canary_max_per_hour: 0 },
        error_rate: { window_ms: 1000, minimum_samples: 1, degrade_ratio: 0.25, degrade_consecutive_windows: 1, recover_ratio: 0.1, recover_consecutive_windows: 1 },
        latency: { window_ms: 1000, minimum_samples: 1, baseline_window_ms: 1000, degrade_multiplier: 2, degrade_absolute_delta_ms: 100, degrade_consecutive_windows: 1, recover_multiplier: 1.5, recover_consecutive_windows: 1 },
        recovery: { circuit_reset_enabled: true, natural_recovery_grace_ms: 1, reset_cooldown_ms: 1, reset_budget_per_hour: 10, reset_budget_per_day: 10, post_reset_probe_delay_ms: 0, failover_enabled: false },
        catalog: { fetch_enabled: false, write_enabled: false, interval_ms: 1000, startup_jitter_max_ms: 0, request_timeout_ms: 1000, removal_block_ratio: 0.2, removal_block_count: 10, consecutive_missing_before_deprecate: 2 },
        alerting: { dedup_window_ms: 1, heartbeat_interval_ms: 1000, deadman_missed_heartbeats: 3 },
        storage: { state_path: join(directory, 'state.json'), audit_path: join(directory, 'audit.jsonl') },
        health: { bind_host: '127.0.0.1', port: 3913 },
      }, { OPSBOT_TOKEN: 'fixture-token', WATCHER_REPAIR_TOKEN: 'x'.repeat(32) }),
      once: true,
      env: { OPSBOT_TOKEN: 'fixture-token', WATCHER_REPAIR_TOKEN: 'x'.repeat(32) },
      now: () => Date.parse('2026-06-22T00:00:02.000Z'),
      tracker,
      catalogAdapter: new OpenRouterCatalogAdapter(`${baseUrl}/catalog`),
    });

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const event = captured[0] as Record<string, unknown>;
    // Non-blocked path: blockedAction is undefined -> category must be 'info'
    expect(event['category']).toBe('info');
    // validates against the full 7-value enum
    const result = validateCreateEventDto(event);
    expect(result.ok, result.ok ? '' : (result as { ok: false; error: string }).error).toBe(true);
  });
});
