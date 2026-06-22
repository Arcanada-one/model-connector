/**
 * Tests for _shadowStart persistence in the watcher state (CONN-0230 Fix 1).
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { runWatcher } from '../src/main.js';
import { parseConfig } from '../src/config.js';

// ── Minimal no-op HTTP stub ───────────────────────────────────────────────
function minimalServer(): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', connectors: [] }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as import('node:net').AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function makeConfig(baseUrl: string, dir: string, healthPort: number) {
  return parseConfig({
    mode: 'shadow',
    model_connector: { base_url: baseUrl },
    opsbot: { base_url: `${baseUrl}/events`, token_env: 'OPSBOT_TOKEN' },
    observation: {
      interval_ms: 60000,
      request_timeout_ms: 500,
      outage_consecutive_failures: 3,
      bounded_canary_enabled: false,
      bounded_canary_max_per_hour: 0,
    },
    error_rate: {
      window_ms: 60000,
      minimum_samples: 10,
      degrade_ratio: 0.5,
      degrade_consecutive_windows: 2,
      recover_ratio: 0.1,
      recover_consecutive_windows: 2,
    },
    latency: {
      window_ms: 60000,
      minimum_samples: 10,
      baseline_window_ms: 300000,
      degrade_multiplier: 3,
      degrade_absolute_delta_ms: 500,
      degrade_consecutive_windows: 2,
      recover_multiplier: 2,
      recover_consecutive_windows: 2,
    },
    recovery: {
      circuit_reset_enabled: false,
      natural_recovery_grace_ms: 60000,
      reset_cooldown_ms: 300000,
      reset_budget_per_hour: 3,
      reset_budget_per_day: 10,
      post_reset_probe_delay_ms: 0,
      failover_enabled: false,
    },
    catalog: {
      fetch_enabled: false,
      write_enabled: false,
      interval_ms: 3600000,
      startup_jitter_max_ms: 0,
      request_timeout_ms: 5000,
      removal_block_ratio: 0.2,
      removal_block_count: 10,
      consecutive_missing_before_deprecate: 3,
    },
    alerting: {
      dedup_window_ms: 60000,
      heartbeat_interval_ms: 60000,
      deadman_missed_heartbeats: 3,
    },
    storage: {
      state_path: join(dir, 'state.json'),
      audit_path: join(dir, 'audit.jsonl'),
    },
    health: { bind_host: '127.0.0.1', port: healthPort },
  }, { OPSBOT_TOKEN: 'x' });
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe('_shadowStart persistence', () => {
  it('stamps _shadowStart on first start when no prior state exists', async () => {
    const { url, port, close } = await minimalServer();
    const dir = await mkdtemp(join(tmpdir(), 'mcw-shadow-stamp-'));
    const before = Date.now();
    try {
      await runWatcher({ config: makeConfig(url, dir, port + 10000 > 65535 ? port - 10000 : port + 10000), once: true, now: () => before });
    } finally {
      await close();
    }
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    expect(state._shadowStart).toBeDefined();
    expect(typeof state._shadowStart).toBe('string');
    const stamped = new Date(state._shadowStart as string).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before - 100);
    expect(stamped).toBeLessThanOrEqual(before + 5000);
  });

  it('preserves existing _shadowStart across restarts (does not overwrite)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcw-shadow-preserve-'));
    const originalStart = '2026-06-01T00:00:00.000Z';
    const store = new StateStore<Record<string, unknown>>(join(dir, 'state.json'));
    await store.write({ heartbeatAt: '2026-06-20T12:00:00.000Z', lastCycleOk: true, _shadowStart: originalStart });

    const { url, port, close } = await minimalServer();
    const healthPort = port + 10000 > 65535 ? port - 10000 : port + 10000;
    try {
      await runWatcher({ config: makeConfig(url, dir, healthPort), once: true, now: () => Date.now() });
    } finally {
      await close();
    }
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    // Must be preserved — not replaced with the current timestamp
    expect(state._shadowStart).toBe(originalStart);
  });

  it('state.json after a write contains heartbeatAt, lastCycleOk, and _shadowStart', async () => {
    const { url, port, close } = await minimalServer();
    const dir = await mkdtemp(join(tmpdir(), 'mcw-shadow-keys-'));
    const healthPort = port + 10000 > 65535 ? port - 10000 : port + 10000;
    try {
      await runWatcher({ config: makeConfig(url, dir, healthPort), once: true, now: () => Date.now() });
    } finally {
      await close();
    }
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    expect(Object.keys(state)).toEqual(
      expect.arrayContaining(['heartbeatAt', 'lastCycleOk', '_shadowStart'])
    );
  });
});
