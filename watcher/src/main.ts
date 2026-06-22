import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import pino from 'pino';
import { AuditLog } from './audit-log.js';
import { OpenRouterCatalogAdapter } from './catalog/openrouter.adapter.js';
import type { CatalogModel, ProviderCatalogAdapter } from './catalog/provider-adapter.js';
import { CatalogSync } from './catalog/catalog-sync.js';
import { classifyFailure, FailureTracker } from './classifier.js';
import { loadConfig, type WatcherConfig } from './config.js';
import { DisabledCatalogWriterAdapter } from './contracts/catalog-writer.adapter.js';
import { startHealthServer } from './health-server.js';
import { ModelConnectorClient } from './model-connector.client.js';
import { computeMetricDelta, normalizeMetrics } from './observation.js';
import { RateWindow } from './rate-window.js';
import { createOpsBotSender, OpsBotClient } from './opsbot.client.js';
import { executeRecovery, RecoveryPolicy } from './recovery-policy.js';
import { StateStore } from './state-store.js';
import type { EvidenceSnapshot, MetricCounters } from './types.js';

const logger = pino();

interface CliOptions {
  config?: string;
  fixture?: string;
  once: boolean;
  help: boolean;
}

interface ObservationClient {
  health(): Promise<unknown>;
  ready(): Promise<unknown>;
  metrics(): Promise<unknown>;
  connectors(): Promise<unknown>;
}

interface WatcherState {
  heartbeatAt: string;
  lastCycleOk: boolean;
}

interface RuntimeState {
  lastCycleOk: boolean;
  lastCatalogFetchAt?: number;
  catalogs: Map<string, CatalogModel[]>;
  /** Per-pair cumulative counters from the PREVIOUS cycle (for delta computation). */
  metricBaselines: Map<string, import('./types.js').MetricCounters>;
  /** Per-pair RateWindow instances for windowed error-rate classification. */
  rateWindows: Map<string, RateWindow>;
}

export interface RunWatcherOptions {
  config: WatcherConfig;
  once?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => number;
  client?: ObservationClient;
  tracker?: FailureTracker;
  recoveryPolicy?: RecoveryPolicy;
  catalogAdapter?: ProviderCatalogAdapter;
}

interface CycleDependencies {
  config: WatcherConfig;
  client: ObservationClient;
  tracker: FailureTracker;
  catalogAdapter: ProviderCatalogAdapter;
  catalogSync: CatalogSync;
  recoveryPolicy: RecoveryPolicy;
  opsbot: OpsBotClient;
  audit: AuditLog;
  store: StateStore<WatcherState>;
  now: () => number;
  env: Record<string, string | undefined>;
  runtime: RuntimeState;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { once: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') options.once = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--config' || arg === '--fixture') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      if (arg === '--config') options.config = value;
      else options.fixture = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export async function runWatcher(options: RunWatcherOptions): Promise<void> {
  const dependencies = createDependencies(options);
  const cycle = async () => runCycle(dependencies);
  if (options.once) {
    await cycle();
    return;
  }
  await startHealthServer(options.config.health.bind_host, options.config.health.port, () => ({
    status: dependencies.runtime.lastCycleOk ? 'ok' : 'degraded',
  }));
  await cycle();
  notifySystemd('READY=1');
  scheduleNextCycle(cycle, options.config.observation.interval_ms);
}

function createDependencies(options: RunWatcherOptions): CycleDependencies {
  const { config } = options;
  const env = options.env ?? process.env;
  const runtime: RuntimeState = { lastCycleOk: false, catalogs: new Map(), metricBaselines: new Map(), rateWindows: new Map() };
  const catalogSync = new CatalogSync(
    new DisabledCatalogWriterAdapter(),
    (provider, models) => {
      runtime.catalogs.set(provider, models);
    },
    {
      removalBlockRatio: config.catalog.removal_block_ratio,
      removalBlockCount: config.catalog.removal_block_count,
      missingBeforeDeprecate: config.catalog.consecutive_missing_before_deprecate,
    },
  );
  return {
    config,
    env,
    runtime,
    client: options.client ?? new ModelConnectorClient(
      config.model_connector.base_url,
      config.observation.request_timeout_ms,
      env.WATCHER_REPAIR_TOKEN,
    ),
    tracker: options.tracker ?? new FailureTracker(),
    catalogAdapter: options.catalogAdapter ?? new OpenRouterCatalogAdapter(),
    catalogSync,
    recoveryPolicy: options.recoveryPolicy ?? new RecoveryPolicy({
      resetBudgetPerHour: config.recovery.reset_budget_per_hour,
      resetBudgetPerDay: config.recovery.reset_budget_per_day,
      cooldownMs: config.recovery.reset_cooldown_ms,
      naturalRecoveryGraceMs: config.recovery.natural_recovery_grace_ms,
    }),
    opsbot: new OpsBotClient(
      createOpsBotSender(config.opsbot.base_url, env[config.opsbot.token_env] ?? ''),
      config.alerting.dedup_window_ms,
    ),
    audit: new AuditLog(config.storage.audit_path),
    store: new StateStore<WatcherState>(config.storage.state_path),
    now: options.now ?? Date.now,
  };
}

async function runCycle(deps: CycleDependencies): Promise<void> {
  const observedAt = new Date(deps.now()).toISOString();
  const results = await Promise.allSettled([
    deps.client.health(),
    deps.client.ready(),
    deps.client.metrics(),
    deps.client.connectors(),
  ]);
  const metricsResult = results[2];
  if (metricsResult.status === 'fulfilled') {
    for (const evidence of normalizeMetrics(metricsResult.value as Record<string, MetricCounters>, observedAt)) {
      const pairKey = `${evidence.provider}:${evidence.model}`;
      const previousBaseline = deps.runtime.metricBaselines.get(pairKey);

      if (previousBaseline === undefined) {
        // First observation of this pair: store baseline for delta on the next cycle.
        // windowedErrorState=null signals "not enough data" — classifier will not fire
        // on error-rate, but deterministic signals (circuit_open, provider_outage,
        // explicitErrorType) still classify normally via the enriched evidence below.
        deps.runtime.metricBaselines.set(pairKey, evidence.counters);
        const primingEvidence = { ...evidence, counters: evidence.counters, windowedErrorState: null as null } as typeof evidence;
        await handleEvidence(primingEvidence, deps);
        continue;
      }

      const delta = computeMetricDelta(previousBaseline, evidence.counters);
      if (delta === null) {
        // Counter reset (MC restart): re-prime, pass windowedErrorState=null this cycle.
        deps.runtime.metricBaselines.set(pairKey, evidence.counters);
        logger.info({ provider: evidence.provider, model: evidence.model }, 'metric counter reset detected — re-priming baseline');
        const resetEvidence = { ...evidence, counters: evidence.counters, windowedErrorState: null as null } as typeof evidence;
        await handleEvidence(resetEvidence, deps);
        continue;
      }

      // Update stored baseline to current cumulative counters.
      deps.runtime.metricBaselines.set(pairKey, evidence.counters);

      // Feed delta into the per-pair RateWindow.
      if (!deps.runtime.rateWindows.has(pairKey)) {
        const errorRateCfg = deps.config.error_rate;
        deps.runtime.rateWindows.set(pairKey, new RateWindow({
          minimumSamples: errorRateCfg.minimum_samples,
          degradeRatio: errorRateCfg.degrade_ratio,
          degradeWindows: errorRateCfg.degrade_consecutive_windows,
          recoverRatio: errorRateCfg.recover_ratio,
          recoverWindows: errorRateCfg.recover_consecutive_windows,
        }));
      }
      const window = deps.runtime.rateWindows.get(pairKey)!;
      const windowResult = window.observe(delta.errorCount, delta.totalRequests);

      // Attach windowed result to evidence before classification.
      // circuitState is preserved from the raw snapshot (set by normalizeMetrics from
      // cumulative circuitOpenCount). counters carry the DELTA for errorCount gating.
      // null ratio means below minimum_samples — classifier treats as no-fault on
      // error-rate path only; deterministic signals are unaffected.
      const enrichedEvidence = {
        ...evidence,
        counters: delta,
        windowedErrorState: windowResult.ratio === null
          ? null
          : windowResult.state,
      } as typeof evidence;

      await handleEvidence(enrichedEvidence, deps);
    }
  }
  await refreshCatalogIfDue(deps);
  deps.runtime.lastCycleOk = results.every((result) => result.status === 'fulfilled');
  await deps.store.write({ heartbeatAt: observedAt, lastCycleOk: deps.runtime.lastCycleOk });
  logger.info({ lastCycleOk: deps.runtime.lastCycleOk }, 'watcher observation cycle completed');
  notifySystemd('WATCHDOG=1');
}

async function handleEvidence(evidence: EvidenceSnapshot, deps: CycleDependencies): Promise<void> {
  const tracked = deps.tracker.update(evidence);
  const failureClass = classifyFailure(evidence);
  if (!failureClass) return;
  const firstSeenAt = tracked.firstSeenAt ? Date.parse(tracked.firstSeenAt) : deps.now();
  const decision = deps.recoveryPolicy.decide({
    provider: evidence.provider,
    model: evidence.model,
    failureClass,
    circuitOpenForMs: Math.max(0, deps.now() - firstSeenAt),
    now: deps.now(),
  });
  if (decision.action === 'reset_circuit') {
    await handleCircuitReset(evidence, failureClass, deps);
    return;
  }
  if (failureClass === 'circuit_open' && decision.reason !== 'mutation_not_eligible') {
    await emitAlert(
      evidence,
      failureClass,
      'reset_circuit',
      'reset_circuit',
      decision.reason,
      deps,
    );
    return;
  }
  await emitAlert(evidence, failureClass, decision.action, undefined, decision.reason, deps);
}

async function handleCircuitReset(
  evidence: EvidenceSnapshot,
  failureClass: NonNullable<ReturnType<typeof classifyFailure>>,
  deps: CycleDependencies,
): Promise<void> {
  if (!deps.config.recovery.circuit_reset_enabled) {
    await emitAlert(
      evidence,
      failureClass,
      'reset_circuit',
      'reset_circuit',
      'blocked_by_config',
      deps,
    );
    return;
  }
  const result = await executeRecovery({
    baseUrl: deps.config.model_connector.base_url,
    token: deps.env.WATCHER_REPAIR_TOKEN ?? '',
    connector: evidence.provider,
    model: evidence.model,
    postProbeDelayMs: deps.config.recovery.post_reset_probe_delay_ms,
    forbidden: () => undefined,
  });
  if (result.recovered) deps.recoveryPolicy.recordReset(evidence.provider, evidence.model, deps.now());
  await emitAlert(evidence, failureClass, 'reset_circuit', undefined, result.outcome, deps, result.recovered);
}

async function emitAlert(
  evidence: EvidenceSnapshot,
  failureClass: NonNullable<ReturnType<typeof classifyFailure>>,
  attemptedAction: string,
  blockedAction: string | undefined,
  outcome: string,
  deps: CycleDependencies,
  fixApplied = false,
): Promise<void> {
  const auditRef = crypto.randomUUID();
  await deps.audit.append({
    audit_ref: auditRef,
    component: 'main-loop',
    level_attempted: 'L2',
    fix_applied: fixApplied,
    outcome,
    provider: evidence.provider,
    model: evidence.model,
    failure_class: failureClass,
    attempted_action: attemptedAction,
    blocked_action: blockedAction,
  });
  const bodyDetail = {
    provider: evidence.provider,
    model: evidence.model,
    failure_class: failureClass,
    evidence,
    attempted_action: attemptedAction,
    blocked_action: blockedAction,
    outcome,
    recommended_operator_step: blockedAction
      ? 'enable circuit reset only after activation gates pass'
      : 'inspect audit record and dependency health',
    audit_ref: auditRef,
  };
  const bodyFull = JSON.stringify(bodyDetail);
  const bodySummary = bodyFull.length <= 4000
    ? bodyFull
    : JSON.stringify({ ...bodyDetail, evidence: { provider: evidence.provider, model: evidence.model, observedAt: evidence.observedAt } });
  await deps.opsbot.emit({
    category: blockedAction ? 'warning' : 'info',
    agent: 'model-connector-watcher',
    title: `MC ${evidence.provider}/${evidence.model}: ${failureClass}`.slice(0, 256),
    body: bodySummary.slice(0, 4000),
    dedup_key: `mc-watcher:${evidence.provider}:${evidence.model}:${failureClass}`.slice(0, 128),
  }, deps.now());
}

async function refreshCatalogIfDue(deps: CycleDependencies): Promise<void> {
  if (!deps.config.catalog.fetch_enabled) return;
  const now = deps.now();
  if (
    deps.runtime.lastCatalogFetchAt !== undefined
    && now - deps.runtime.lastCatalogFetchAt < deps.config.catalog.interval_ms
  ) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.config.catalog.request_timeout_ms);
  try {
    const current = await deps.catalogAdapter.fetch(controller.signal);
    const previous = deps.runtime.catalogs.get(deps.catalogAdapter.provider) ?? [];
    await deps.catalogSync.reconcile(
      deps.catalogAdapter.provider,
      previous,
      current,
      deps.config.catalog.write_enabled,
    );
    deps.runtime.lastCatalogFetchAt = now;
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleNextCycle(cycle: () => Promise<void>, intervalMs: number): void {
  setTimeout(async () => {
    try {
      await cycle();
    } catch (error) {
      logger.error({ err: error }, 'observation cycle failed');
    } finally {
      scheduleNextCycle(cycle, intervalMs);
    }
  }, intervalMs);
}


export function isDirectlyExecuted(argv1: string | undefined, metaUrl: string): boolean {
  if (!argv1) return false;
  try {
    const invokedPath = realpathSync(argv1);
    const selfPath = realpathSync(fileURLToPath(metaUrl));
    return invokedPath === selfPath;
  } catch {
    // fallback: compare raw URLs (e.g. in environments where realpath fails)
    return metaUrl === pathToFileURL(argv1).href;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: model-connector-watcher [--config PATH] [--once] [--fixture PATH]\n');
    return;
  }
  if (options.fixture) {
    const evidence = JSON.parse(await readFile(options.fixture, 'utf8')) as EvidenceSnapshot;
    process.stdout.write(`${JSON.stringify({ ...evidence, failureClass: classifyFailure(evidence) })}\n`);
    return;
  }
  if (!options.config) throw new Error('--config is required without --fixture');
  await runWatcher({ config: await loadConfig(options.config), once: options.once });
}

function notifySystemd(message: 'READY=1' | 'WATCHDOG=1'): void {
  if (!process.env.NOTIFY_SOCKET) return;
  const child = spawn('/usr/bin/systemd-notify', [message], { stdio: 'ignore' });
  child.on('error', (error) => logger.warn({ err: error }, 'systemd notification failed'));
}

if (isDirectlyExecuted(process.argv[1], import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, 'watcher failed');
    process.exitCode = 1;
  });
}
