/**
 * Whole-chain budget for the failover gateway and the cascade profile.
 * 180s leaves 60s after one default connector hang (CONNECTOR_TIMEOUT_MS is 120s).
 * `CHAIN_DEADLINE_MS` in the env schema is this value unless an operator sets it.
 */
export const DEFAULT_CHAIN_DEADLINE_MS = 180_000;

/** Raw env surface for `CHAIN_DEADLINE_MS` (graph `config_key` + operator override). */
export function readChainDeadlineEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env === process.env ? process.env.CHAIN_DEADLINE_MS : env.CHAIN_DEADLINE_MS;
}
