#!/usr/bin/env node
/**
 * CONN-0230 fixture generator for evidence-analyzer dry-run.
 * Generates 8 days of synthetic audit.jsonl + state.json (simulated heartbeat).
 *
 * Scenario:
 *   - 23040 cycles over 8 days (30s cadence, 2 provider:model pairs)
 *   - 3 genuine burst outages (consecutive → not proxy-FP)
 *   - 1 isolated outage (proxy-FP, ~3.7% rate for pair 0)
 *   - 0 flaps (stable shadow)
 *
 * Expected analyzer verdict: PASS (window=8d ≥7, samples time-derived ~23040 ≥500,
 *   FP<5% when proxy-FP is 1/27≈3.7% for pair 0, 0/26=0% for pair 1,
 *   flaps 0/day ≤1)
 */
import { writeFileSync } from 'node:fs';

const PAIRS = [
  { provider: 'openrouter', model: 'claude-3-5-sonnet' },
  { provider: 'openrouter', model: 'gpt-4o' },
];
const START = new Date('2026-06-15T00:00:00.000Z').getTime();
const CYCLE_MS = 30000;
const CYCLES = 8 * 24 * 60 * 2; // 8 days

const lines = [];

for (let c = 0; c < CYCLES; c++) {
  const ts = new Date(START + c * CYCLE_MS).toISOString();

  for (const [pIdx, pair] of PAIRS.entries()) {
    // Burst 1: cycles 100-110 (consecutive within 30s = genuine outage, not FP)
    const burst1 = c >= 100 && c <= 110;
    // Burst 2: cycles 1000-1005 (genuine)
    const burst2 = c >= 1000 && c <= 1005;
    // Burst 3: cycles 8000-8008 (genuine)
    const burst3 = c >= 8000 && c <= 8008;
    // Isolated single event (proxy-FP) — only for pair 0 at cycle 500
    const isolatedFp = c === 500 && pIdx === 0;

    if (burst1 || burst2 || burst3 || isolatedFp) {
      lines.push(JSON.stringify({
        audit_ref: `fixture-${c}-${pair.provider}-${pair.model}`,
        component: 'main-loop',
        level_attempted: 'L2',
        fix_applied: false,
        outcome: 'blocked_by_config',
        provider: pair.provider,
        model: pair.model,
        failure_class: 'provider_outage',
        attempted_action: 'reset_circuit',
        blocked_action: 'reset_circuit',
        timestamp: ts,
      }));
    }
  }
}

const endTs = new Date(START + (CYCLES - 1) * CYCLE_MS).toISOString();
const startTs = new Date(START).toISOString();

writeFileSync('/tmp/conn-0230-fixture-audit.jsonl', lines.join('\n') + '\n');
writeFileSync('/tmp/conn-0230-fixture-state.json', JSON.stringify({
  heartbeatAt: endTs,
  lastCycleOk: true,
  _shadowStart: startTs,  // non-schema field for window calculation
}));

console.log(`Generated ${lines.length} audit records spanning ${CYCLES} cycles (8 days)`);
console.log(`State: heartbeatAt=${endTs}, _shadowStart=${startTs}`);
console.log(`Pair 0 audit records: ${lines.filter(l => l.includes('claude-3-5-sonnet')).length}`);
console.log(`Pair 1 audit records: ${lines.filter(l => l.includes('gpt-4o')).length}`);
console.log(`Expected: 1 proxy-FP (cycle 500 isolated) for pair 0, 0 for pair 1`);
