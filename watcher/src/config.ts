import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const positiveInt = z.number().int().positive();
const observation = z.object({
  interval_ms: positiveInt,
  request_timeout_ms: positiveInt,
  outage_consecutive_failures: positiveInt,
  bounded_canary_enabled: z.boolean(),
  bounded_canary_max_per_hour: z.number().int().min(0).max(2),
}).strict();
const errorRate = z.object({
  window_ms: positiveInt,
  minimum_samples: positiveInt,
  degrade_ratio: z.number().min(0).max(1),
  degrade_consecutive_windows: positiveInt,
  recover_ratio: z.number().min(0).max(1),
  recover_consecutive_windows: positiveInt,
}).strict();
const latency = z.object({
  window_ms: positiveInt,
  minimum_samples: positiveInt,
  baseline_window_ms: positiveInt,
  degrade_multiplier: z.number().positive(),
  degrade_absolute_delta_ms: positiveInt,
  degrade_consecutive_windows: positiveInt,
  recover_multiplier: z.number().positive(),
  recover_consecutive_windows: positiveInt,
}).strict();
const recovery = z.object({
  circuit_reset_enabled: z.boolean(),
  natural_recovery_grace_ms: positiveInt,
  reset_cooldown_ms: positiveInt,
  reset_budget_per_hour: positiveInt,
  reset_budget_per_day: positiveInt,
  post_reset_probe_delay_ms: z.number().int().nonnegative(),
  failover_enabled: z.boolean(),
}).strict();
const catalog = z.object({
  fetch_enabled: z.boolean(),
  write_enabled: z.boolean(),
  interval_ms: positiveInt,
  startup_jitter_max_ms: z.number().int().nonnegative(),
  request_timeout_ms: positiveInt,
  removal_block_ratio: z.number().min(0).max(1),
  removal_block_count: positiveInt,
  consecutive_missing_before_deprecate: positiveInt,
}).strict();

export const watcherConfigSchema = z.object({
  mode: z.enum(['shadow', 'active']),
  model_connector: z.object({ base_url: z.string().url() }).strict(),
  opsbot: z.object({ base_url: z.string().url(), token_env: z.string().min(1) }).strict(),
  observation,
  error_rate: errorRate,
  latency,
  recovery,
  catalog,
  alerting: z.object({
    dedup_window_ms: positiveInt,
    heartbeat_interval_ms: positiveInt,
    deadman_missed_heartbeats: positiveInt,
  }).strict(),
  storage: z.object({ state_path: z.string().min(1), audit_path: z.string().min(1) }).strict(),
  health: z.object({ bind_host: z.enum(['127.0.0.1', '::1']), port: z.number().int().min(1).max(65535) }).strict(),
}).strict().superRefine((value, ctx) => {
  const mutation = value.recovery.circuit_reset_enabled || value.recovery.failover_enabled || value.catalog.write_enabled;
  if (value.mode === 'shadow' && mutation) {
    ctx.addIssue({ code: 'custom', path: ['mode'], message: 'shadow mode forbids mutation toggles' });
  }
});

export type WatcherConfig = z.infer<typeof watcherConfigSchema>;

export function parseConfig(input: unknown, env: Record<string, string | undefined> = process.env): WatcherConfig {
  const bindHost = (input as { health?: { bind_host?: unknown } } | null)?.health?.bind_host;
  if (bindHost !== '127.0.0.1' && bindHost !== '::1') throw new Error('health bind must be loopback');
  const config = watcherConfigSchema.parse(input);
  if (!env[config.opsbot.token_env]) throw new Error(`missing Ops Bot auth env: ${config.opsbot.token_env}`);
  if (config.recovery.circuit_reset_enabled && !env.WATCHER_REPAIR_TOKEN) {
    throw new Error('WATCHER_REPAIR_TOKEN required when circuit reset is enabled');
  }
  return config;
}

export async function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Promise<WatcherConfig> {
  return parseConfig(parseYaml(await readFile(path, 'utf8')), env);
}
