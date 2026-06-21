import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const valid = {
  mode: 'shadow',
  model_connector: { base_url: 'http://100.64.0.1:3900' },
  opsbot: { base_url: 'https://ops.example.com', token_env: 'OPSBOT_TOKEN' },
  observation: {
    interval_ms: 30000,
    request_timeout_ms: 5000,
    outage_consecutive_failures: 3,
    bounded_canary_enabled: false,
    bounded_canary_max_per_hour: 2,
  },
  error_rate: {
    window_ms: 300000,
    minimum_samples: 20,
    degrade_ratio: 0.25,
    degrade_consecutive_windows: 2,
    recover_ratio: 0.1,
    recover_consecutive_windows: 3,
  },
  latency: {
    window_ms: 300000,
    minimum_samples: 20,
    baseline_window_ms: 86400000,
    degrade_multiplier: 2,
    degrade_absolute_delta_ms: 1000,
    degrade_consecutive_windows: 3,
    recover_multiplier: 1.5,
    recover_consecutive_windows: 3,
  },
  recovery: {
    circuit_reset_enabled: false,
    natural_recovery_grace_ms: 60000,
    reset_cooldown_ms: 900000,
    reset_budget_per_hour: 2,
    reset_budget_per_day: 6,
    post_reset_probe_delay_ms: 30000,
    failover_enabled: false,
  },
  catalog: {
    fetch_enabled: true,
    write_enabled: false,
    interval_ms: 21600000,
    startup_jitter_max_ms: 600000,
    request_timeout_ms: 15000,
    removal_block_ratio: 0.2,
    removal_block_count: 10,
    consecutive_missing_before_deprecate: 2,
  },
  alerting: { dedup_window_ms: 900000, heartbeat_interval_ms: 30000, deadman_missed_heartbeats: 3 },
  storage: { state_path: '/tmp/state.json', audit_path: '/tmp/audit.jsonl' },
  health: { bind_host: '127.0.0.1', port: 3911 },
};

describe('closed watcher configuration', () => {
  it('accepts shadow-safe defaults', () => {
    expect(parseConfig(valid, { OPSBOT_TOKEN: 'x' }).mode).toBe('shadow');
  });

  it('rejects unknown keys', () => {
    expect(() => parseConfig({ ...valid, unexpected: true }, { OPSBOT_TOKEN: 'x' })).toThrow();
  });

  it('rejects mutation in shadow mode', () => {
    expect(() =>
      parseConfig(
        { ...valid, recovery: { ...valid.recovery, circuit_reset_enabled: true } },
        { OPSBOT_TOKEN: 'x', WATCHER_REPAIR_TOKEN: 'x'.repeat(32) },
      ),
    ).toThrow(/shadow/);
  });

  it('rejects non-loopback health bind', () => {
    expect(() =>
      parseConfig({ ...valid, health: { bind_host: '0.0.0.0', port: 3911 } }, { OPSBOT_TOKEN: 'x' }),
    ).toThrow(/loopback/);
  });
});

// ── CONN-0230: shadow prod config template (V-AC-1) ────────────────────────
// Verifies the deployed config template at deploy/config.shadow.yaml parses
// correctly and that all mutation toggles throw when enabled in shadow mode.
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

describe('CONN-0230 shadow prod config template (V-AC-1)', () => {
  let raw: unknown;

  beforeEach(async () => {
    const content = await readFile(new URL('../deploy/config.shadow.yaml', import.meta.url), 'utf8');
    raw = parseYaml(content);
  });

  it('parses shadow-safe prod config template', () => {
    const cfg = parseConfig(raw as Parameters<typeof parseConfig>[0], { OPSBOT_TOKEN: 'test-token' });
    expect(cfg.mode).toBe('shadow');
    expect(cfg.recovery.circuit_reset_enabled).toBe(false);
    expect(cfg.recovery.failover_enabled).toBe(false);
    expect(cfg.catalog.write_enabled).toBe(false);
    expect(cfg.observation.bounded_canary_enabled).toBe(false);
    expect(cfg.health.bind_host).toBe('127.0.0.1');
    expect(cfg.model_connector.base_url).toBe('https://connector.arcanada.ai');
  });

  it('rejects circuit_reset_enabled=true in prod template config', () => {
    expect(() =>
      parseConfig(
        { ...(raw as object), recovery: { ...((raw as Record<string, unknown>)['recovery'] as object), circuit_reset_enabled: true } },
        { OPSBOT_TOKEN: 'x', WATCHER_REPAIR_TOKEN: 'x'.repeat(32) },
      ),
    ).toThrow(/shadow/);
  });

  it('rejects failover_enabled=true in prod template config', () => {
    expect(() =>
      parseConfig(
        { ...(raw as object), recovery: { ...((raw as Record<string, unknown>)['recovery'] as object), failover_enabled: true } },
        { OPSBOT_TOKEN: 'x' },
      ),
    ).toThrow(/shadow/);
  });

  it('rejects catalog.write_enabled=true in prod template config', () => {
    expect(() =>
      parseConfig(
        { ...(raw as object), catalog: { ...((raw as Record<string, unknown>)['catalog'] as object), write_enabled: true } },
        { OPSBOT_TOKEN: 'x' },
      ),
    ).toThrow(/shadow/);
  });
});
