#!/usr/bin/env node
/**
 * CONN-0230 Evidence Analyzer
 *
 * Read-only analyzer over the watcher's audit.jsonl + state.json output.
 * Measures the three shadow-evidence thresholds defined in CONN-0230-plan.md §5:
 *
 *   SAMPLE    ≥500 per provider:model  (time-derived from window duration at 30s cadence)
 *   FP_RATE   <5% per provider:model   (proxy false-positive classification rate)
 *   FLAP      ≤1/day/pair avg, max≤2   (health-state oscillation in rolling 1h window)
 *   WINDOW    ≥7 consecutive days       (from state.json heartbeat span or audit span)
 *
 * Usage:
 *   node evidence-analyzer.js --audit AUDIT_JSONL --state STATE_JSON [--window-days N]
 *
 * Exit codes: 0 = all thresholds met, 1 = one or more failed, 2 = error.
 */
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// ── Thresholds (CONN-0230-plan.md §5, fixed) ──────────────────────────────
const THRESHOLD = {
  SAMPLES_PER_PAIR: 500,
  FP_RATE_MAX: 0.05,
  FLAP_PER_DAY_MAX: 1,
  FLAP_PER_DAY_SINGLE_MAX: 2,
  WINDOW_DAYS_MIN: 7,
  FLAP_WINDOW_MS: 60 * 60 * 1000,
  MIN_FP_GATE_SAMPLES: 20,
  CYCLE_MS: 30000,
  // Proxy FP: event is isolated if no preceding or following event for the
  // same pair within 2.5 minutes (5 cycles × 30s). A burst start has a
  // successor within 30s; an isolated event has neither predecessor nor successor.
  ISOLATION_GAP_MS: 150000,
};

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(args) {
  const opts = { auditPath: null, statePath: null, windowDays: THRESHOLD.WINDOW_DAYS_MIN };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--audit') opts.auditPath = args[++i];
    else if (args[i] === '--state') opts.statePath = args[++i];
    else if (args[i] === '--window-days') opts.windowDays = parseInt(args[++i], 10);
    else if (args[i] === '--help') {
      console.log('Usage: evidence-analyzer.js --audit AUDIT_JSONL [--state STATE_JSON] [--window-days N]');
      process.exit(0);
    }
  }
  if (!opts.auditPath) throw new Error('--audit path is required');
  return opts;
}

// ── Read audit.jsonl ────────────────────────────────────────────────────────
async function readAuditLog(path) {
  const records = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return records;
}

// ── Window: prefer state.json _shadowStart+heartbeatAt, fallback audit span ─
async function computeWindow(statePath, records, requiredWindowDays) {
  let startTs = null, endTs = null;

  if (statePath) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state._shadowStart) startTs = new Date(state._shadowStart).getTime();
      if (state.heartbeatAt) endTs = new Date(state.heartbeatAt).getTime();
    } catch { /* state missing */ }
  }

  // Fallback to audit record span
  if (records.length > 0) {
    const ts = records.map(r => new Date(r.timestamp).getTime()).filter(t => !isNaN(t));
    if (ts.length > 0) {
      if (!startTs) startTs = Math.min(...ts);
      if (!endTs) endTs = Math.max(...ts);
    }
  }

  if (!startTs || !endTs) return { days: 0, startIso: null, endIso: null, estimatedSamples: 0 };
  const days = (endTs - startTs) / (86400 * 1000);
  const estimatedSamples = Math.floor((endTs - startTs) / THRESHOLD.CYCLE_MS);
  return {
    days,
    startIso: new Date(startTs).toISOString(),
    endIso: new Date(endTs).toISOString(),
    estimatedSamples,
  };
}


// ── Filter records to the analysis window ─────────────────────────────────
// Pure function: drop any record whose timestamp falls outside [startTs, endTs].
// endTs=null means open-ended (up to the latest record).
export function filterToWindow(records, startTs, endTs) {
  return records.filter(r => {
    const t = new Date(r.timestamp).getTime();
    if (isNaN(t)) return false;
    if (startTs !== null && t < startTs) return false;
    if (endTs !== null && t > endTs) return false;
    return true;
  });
}

// ── Sample count (from audit records as lower bound) ──────────────────────
function computeSamples(records) {
  const counts = new Map();
  for (const r of records) {
    const key = `${r.provider}:${r.model}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ── False-positive proxy ──────────────────────────────────────────────────
// An audit record is a proxy-FP if it is an ISOLATED outage event:
// no other record for the same pair within ISOLATION_GAP_MS before OR after it.
// Burst events have a neighbor within 30s → they are NOT proxy-FP.
function computeFpRate(records) {
  const byPair = new Map();
  for (const r of records) {
    const key = `${r.provider}:${r.model}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(r);
  }
  const result = new Map();
  for (const [key, recs] of byPair) {
    const sorted = recs.slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const total = sorted.length;
    let proxyFp = 0;
    for (let i = 0; i < sorted.length; i++) {
      const ts = new Date(sorted[i].timestamp).getTime();
      const prevTs = i > 0 ? new Date(sorted[i - 1].timestamp).getTime() : null;
      const nextTs = i < sorted.length - 1 ? new Date(sorted[i + 1].timestamp).getTime() : null;
      const hasPrevNeighbor = prevTs !== null && (ts - prevTs) <= THRESHOLD.ISOLATION_GAP_MS;
      const hasNextNeighbor = nextTs !== null && (nextTs - ts) <= THRESHOLD.ISOLATION_GAP_MS;
      const isolated = !hasPrevNeighbor && !hasNextNeighbor;
      if (isolated) proxyFp++;
    }
    const rate = total === 0 ? 0 : proxyFp / total;
    result.set(key, { total, proxyFp, rate, gated: total >= THRESHOLD.MIN_FP_GATE_SAMPLES });
  }
  return result;
}

// ── Flap detection ────────────────────────────────────────────────────────
// Flap = degraded→recovered→degraded where the full cycle fits in 1h.
// We reconstruct implied recoveries from gaps >90s (3 × missed heartbeats = dead-man).
function computeFlaps(records) {
  const byPair = new Map();
  for (const r of records) {
    const key = `${r.provider}:${r.model}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(new Date(r.timestamp).getTime());
  }

  const result = new Map();
  for (const [key, tsArr] of byPair) {
    const sorted = tsArr.slice().sort((a, b) => a - b);
    const flapsByDay = new Map();

    // Build state transitions
    const transitions = [];
    for (let i = 0; i < sorted.length; i++) {
      transitions.push({ ts: sorted[i], state: 'degraded' });
      const next = sorted[i + 1];
      if (!next || (next - sorted[i]) > 90000) {
        transitions.push({ ts: sorted[i] + 35000, state: 'recovered' });
      }
    }

    // Count flaps
    for (let i = 0; i < transitions.length - 2; i++) {
      const t0 = transitions[i];
      const t1 = transitions[i + 1];
      const t2 = transitions[i + 2];
      if (t0.state === 'degraded' && t1.state === 'recovered' && t2.state === 'degraded') {
        if (t2.ts - t0.ts <= THRESHOLD.FLAP_WINDOW_MS) {
          const day = new Date(t2.ts).toISOString().slice(0, 10);
          flapsByDay.set(day, (flapsByDay.get(day) ?? 0) + 1);
        }
      }
    }

    const counts = [...flapsByDay.values()];
    const totalFlaps = counts.reduce((s, v) => s + v, 0);
    const days = flapsByDay.size === 0 ? 1 : flapsByDay.size;
    result.set(key, {
      flapsByDay,
      avgPerDay: totalFlaps / days,
      singleDayMax: counts.length === 0 ? 0 : Math.max(...counts),
    });
  }
  return result;
}

// ── Build report ───────────────────────────────────────────────────────────
function buildReport({ samples, fpRates, flaps, window, requiredWindowDays }) {
  const pass = [], fail = [], warn = [];

  // Window
  const windowOk = window.days >= requiredWindowDays;
  (windowOk ? pass : fail).push(
    `WINDOW: ${window.days.toFixed(2)} days [${window.startIso} → ${window.endIso}] — threshold ≥${requiredWindowDays}`
  );

  // All pairs (from audit records or from implicit healthy-shadow state)
  const allPairs = new Set([...samples.keys(), ...fpRates.keys(), ...flaps.keys()]);

  if (allPairs.size === 0) {
    // No audit records → perfectly healthy shadow window
    const sampleOk = window.estimatedSamples >= THRESHOLD.SAMPLES_PER_PAIR;
    (sampleOk ? pass : fail).push(
      `SAMPLE [all pairs]: no failures observed. Estimated cycles from window: ${window.estimatedSamples} — threshold ≥${THRESHOLD.SAMPLES_PER_PAIR}`
    );
    pass.push('FP_RATE [all pairs]: 0 classification events → rate = 0% (PASS by definition)');
    pass.push('FLAP [all pairs]: 0 events → 0 flaps/day (PASS)');
  } else {
    for (const pair of allPairs) {
      // Sample (time-derived is canonical)
      const sampleOk = window.estimatedSamples >= THRESHOLD.SAMPLES_PER_PAIR;
      const auditCount = samples.get(pair) ?? 0;
      (sampleOk ? pass : fail).push(
        `SAMPLE [${pair}]: ~${window.estimatedSamples} cycles (time-derived), ${auditCount} failure audit-records — threshold ≥${THRESHOLD.SAMPLES_PER_PAIR}`
      );

      // FP rate
      const fp = fpRates.get(pair);
      if (fp) {
        const fpPct = (fp.rate * 100).toFixed(1);
        const fpOk = fp.rate < THRESHOLD.FP_RATE_MAX;
        const line = `FP_RATE [${pair}]: proxy-fp=${fp.proxyFp}/${fp.total} (${fpPct}%) — threshold <${THRESHOLD.FP_RATE_MAX * 100}%`;
        if (!fp.gated) warn.push(line + ` [report-not-gated: N<${THRESHOLD.MIN_FP_GATE_SAMPLES}]`);
        else (fpOk ? pass : fail).push(line + ' [GATED]');
      }

      // Flap rate
      const flap = flaps.get(pair);
      if (flap) {
        const avgOk = flap.avgPerDay <= THRESHOLD.FLAP_PER_DAY_MAX;
        const singleOk = flap.singleDayMax <= THRESHOLD.FLAP_PER_DAY_SINGLE_MAX;
        (avgOk && singleOk ? pass : fail).push(
          `FLAP [${pair}]: avg=${flap.avgPerDay.toFixed(2)}/day, max-single-day=${flap.singleDayMax} — threshold avg≤${THRESHOLD.FLAP_PER_DAY_MAX}, max≤${THRESHOLD.FLAP_PER_DAY_SINGLE_MAX}`
        );
      }
    }
  }

  return { pass, fail, warn, verdict: fail.length === 0 ? 'PASS' : 'FAIL' };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const records = await readAuditLog(opts.auditPath);
  const window = await computeWindow(opts.statePath, records, opts.windowDays);
  const startTs = window.startIso ? new Date(window.startIso).getTime() : null;
  const endTs = window.endIso ? new Date(window.endIso).getTime() : null;
  const windowedRecords = filterToWindow(records, startTs, endTs);

  const samples = computeSamples(windowedRecords);
  const fpRates = computeFpRate(windowedRecords);
  const flaps = computeFlaps(windowedRecords);

  const report = buildReport({ samples, fpRates, flaps, window, requiredWindowDays: opts.windowDays });

  console.log('\n=== CONN-0230 Evidence Analyzer ===');
  console.log(`Audit file   : ${opts.auditPath}`);
  console.log(`State file   : ${opts.statePath ?? '(none)'}`);
  console.log(`Records      : ${records.length} total, ${windowedRecords.length} in-window [${window.startIso ?? 'unknown'} → ${window.endIso ?? 'unknown'}]`);
  console.log(`Pairs        : ${samples.size > 0 ? [...samples.keys()].join(', ') : '(none — all healthy)'}`);
  console.log(`Window       : ${window.days.toFixed(2)} days (est. ${window.estimatedSamples} cycles/pair)`);
  console.log(`\nVERDICT: ${report.verdict}\n`);

  if (report.pass.length) { console.log('PASSED:'); report.pass.forEach(l => console.log('  ✓ ' + l)); }
  if (report.warn.length) { console.log('\nWARNINGS:'); report.warn.forEach(l => console.log('  ! ' + l)); }
  if (report.fail.length) { console.log('\nFAILED:'); report.fail.forEach(l => console.log('  ✗ ' + l)); }

  console.log(`\nThresholds (CONN-0230-plan.md §5):`);
  console.log(`  samples/pair  ≥ ${THRESHOLD.SAMPLES_PER_PAIR} (time-derived from window/30s)`);
  console.log(`  fp_rate       < ${THRESHOLD.FP_RATE_MAX * 100}% (proxy-isolated; operator correlates ground truth)`);
  console.log(`  flap_avg      ≤ ${THRESHOLD.FLAP_PER_DAY_MAX}/day`);
  console.log(`  flap_max_day  ≤ ${THRESHOLD.FLAP_PER_DAY_SINGLE_MAX}`);
  console.log(`  window        ≥ ${opts.windowDays} days`);
  console.log(`\nNote: FP proxy excludes burst events (neighbor within 2.5 min). Operator`);
  console.log(`  must correlate /connector-status side-log for ground-truth validation.`);

  process.exitCode = report.verdict === 'PASS' ? 0 : 1;
}

main().catch(err => { console.error('ERROR:', err.message); process.exitCode = 2; });
