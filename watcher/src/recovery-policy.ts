import type { FailureClass } from './types.js';

export const ACTION_ALLOWLIST = [
  'observe',
  'alert',
  'fetch_catalog',
  'write_catalog_if_contract_available',
  'reset_circuit',
  'failover_if_contract_available',
] as const;

interface ResetRecord {
  provider: string;
  model: string;
  at: number;
}

export class RecoveryPolicy {
  private readonly resets: ResetRecord[] = [];

  constructor(private readonly config: {
    resetBudgetPerHour: number;
    resetBudgetPerDay: number;
    cooldownMs: number;
    naturalRecoveryGraceMs?: number;
  }) {}

  decide(input: { provider: string; model: string; failureClass: FailureClass; circuitOpenForMs: number; now: number }) {
    const graceMs = this.config.naturalRecoveryGraceMs ?? 60000;
    if (input.failureClass !== 'circuit_open' || input.model === 'unknown' || input.circuitOpenForMs <= graceMs) {
      return { action: 'alert' as const, reason: 'mutation_not_eligible' };
    }
    const matching = this.resets.filter((record) => record.provider === input.provider && record.model === input.model);
    const last = matching.at(-1);
    if (last && input.now - last.at < this.config.cooldownMs) return { action: 'alert' as const, reason: 'cooldown' };
    if (matching.filter((record) => input.now - record.at < 3600000).length >= this.config.resetBudgetPerHour) {
      return { action: 'alert' as const, reason: 'hourly_budget' };
    }
    if (matching.filter((record) => input.now - record.at < 86400000).length >= this.config.resetBudgetPerDay) {
      return { action: 'alert' as const, reason: 'daily_budget' };
    }
    return { action: 'reset_circuit' as const, reason: 'eligible_circuit_open' };
  }

  recordReset(provider: string, model: string, at: number): void {
    this.resets.push({ provider, model, at });
  }
}

export async function executeRecovery(input: {
  baseUrl: string;
  token: string;
  connector: string;
  model: string;
  postProbeDelayMs: number;
  forbidden: () => void;
}) {
  const reset = await fetch(`${input.baseUrl}/internal/watcher/circuit-breaker/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-watcher-repair-token': input.token },
    body: JSON.stringify({ connector: input.connector, model: input.model }),
  });
  if (!reset.ok) return { recovered: false, outcome: `reset_http_${reset.status}` };
  if (input.postProbeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, input.postProbeDelayMs));
  const probe = await fetch(`${input.baseUrl}/health/connectors`);
  const body = await probe.json() as { status?: string };
  return { recovered: probe.ok && body.status === 'ok', outcome: body.status ?? 'unknown' };
}
