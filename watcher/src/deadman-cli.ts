import pino from 'pino';
import { loadConfig } from './config.js';
import { Deadman } from './deadman.js';
import { createOpsBotSender } from './opsbot.client.js';
import { StateStore } from './state-store.js';

const logger = pino();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: deadman-cli --config PATH');
  const config = await loadConfig(args[1]!);
  const state = await new StateStore<{ heartbeatAt?: string }>(config.storage.state_path).read();
  const token = process.env[config.opsbot.token_env];
  if (!token) throw new Error('Ops Bot token missing');
  const send = createOpsBotSender(config.opsbot.base_url, token);
  const deadman = new Deadman(
    config.alerting.heartbeat_interval_ms,
    config.alerting.deadman_missed_heartbeats,
    () => send({
      category: 'fatal',
      agent: 'model-connector-watcher-deadman',
      title: 'Model Connector watcher heartbeat is stale',
      body: JSON.stringify({ audit_ref: crypto.randomUUID(), heartbeat_at: state?.heartbeatAt ?? null }),
      dedup_key: 'model-connector-watcher-deadman',
    }),
  );
  await deadman.check(state?.heartbeatAt ?? '1970-01-01T00:00:00.000Z');
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'deadman check failed');
  process.exitCode = 1;
});
