import { describe, expect, it } from 'vitest';
import { ACTION_ALLOWLIST, RecoveryPolicy } from '../src/recovery-policy.js';

describe('bounded recovery policy', () => {
  it('exposes exactly the approved action allowlist', () => {
    expect(ACTION_ALLOWLIST).toEqual([
      'observe',
      'alert',
      'fetch_catalog',
      'write_catalog_if_contract_available',
      'reset_circuit',
      'failover_if_contract_available',
    ]);
  });

  it.each(['authentication', 'billing', 'unknown'] as const)('blocks %s failures', (failureClass) => {
    const policy = new RecoveryPolicy({ resetBudgetPerHour: 2, resetBudgetPerDay: 6, cooldownMs: 900000 });
    expect(policy.decide({ provider: 'p', model: 'm', failureClass, circuitOpenForMs: 100000, now: 0 }).action).toBe('alert');
  });

  it('permits one eligible scoped reset then enforces cooldown', () => {
    const policy = new RecoveryPolicy({ resetBudgetPerHour: 2, resetBudgetPerDay: 6, cooldownMs: 900000 });
    expect(policy.decide({ provider: 'p', model: 'm', failureClass: 'circuit_open', circuitOpenForMs: 60001, now: 1 }).action).toBe('reset_circuit');
    policy.recordReset('p', 'm', 1);
    expect(policy.decide({ provider: 'p', model: 'm', failureClass: 'circuit_open', circuitOpenForMs: 60001, now: 2 }).action).toBe('alert');
  });
});
