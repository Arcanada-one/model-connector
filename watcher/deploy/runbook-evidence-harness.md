---
doc_type: runbook
task_id: CONN-0230
parent: CONN-0227
created: 2026-06-22
status: ready-for-operator
---

# CONN-0230 — Evidence-Collection Harness

## Purpose

This document specifies the read-only evidence analyzer that computes the three
shadow-evidence thresholds required to close CONN-0227 expectations #3 (catalog re-fetch)
and #5 (AAL declaration runtime proof). It is run by the operator at the end of the 7-day
shadow window.

Analyzer script: `watcher/deploy/evidence-analyzer.js` (on arcana-dev,
`/home/dev/arcanada/Projects/Model Connector/code/watcher/deploy/`).

---

## Threshold definitions (CONN-0230-plan.md §5 — fixed)

### Sample count: ≥500 per provider:model

**Definition:** One `EvidenceSnapshot` for one `provider:model` pair produced in one
observation cycle (30s). The audit log captures only *failure* events; total cycle count
is estimated from `(window_duration_ms / 30000)` using the state.json `_shadowStart` +
`heartbeatAt` span (more reliable than sparse audit timestamps).

**Pass criterion:** time-derived estimate ≥ 500 per pair.

At 30s cadence, a pair reaches 500 in ≈4.2 hours; 7 days → ~20160 cycles. The threshold
is effectively unconditional once the window check passes.

---

### False-positive rate: <5% per provider:model

**Definition:** A classification event (audit.jsonl record) is a proxy false-positive
if it is **isolated** — no other record for the same `provider:model` within 2.5 minutes
(5 × 30s = 150000ms) before or after it.

Burst events (consecutive failures within 30-150s) are genuine outages and are excluded
from the FP count. Only truly isolated single events (no neighbor) are proxied as FP.

**Pass criterion:** `proxy_fp_count / total_classification_events < 0.05` per pair.

**Gating:** pairs with fewer than 20 total classification events are reported but NOT
gated (too few to be statistically meaningful). Their FP count is logged as a warning.

**Ground-truth note:** the proxy is automated. For a final production certification,
the operator should correlate audit timestamps with the prod MC `/connector-status` +
`/metrics` side log (captured every 30s by the watcher's `connectors()` call). A proxy-FP
that corresponds to a real MC connector failure in the side log is a genuine negative
(not a false positive) and reduces the FP count.

---

### Flap rate: ≤1/day average, max ≤2 on any single day

**Definition:** A flap = `provider:model` transitions `degraded → recovered → degraded`
where the full cycle (start of first degraded to start of second degraded) fits inside
a rolling 60-minute window.

Reconstructed from audit.jsonl: consecutive records for the same pair within 90s are
treated as a continuous degraded state; a gap >90s implies an implicit recovery. A
`degraded → [implied recovery] → degraded` cycle within 1 hour = 1 flap.

**Pass criterion:**
- Average flap count per day ≤ 1 (summed over all days with flap events / total days)
- No single day's flap count > 2

---

### Window: ≥7 consecutive days

**Definition:** ≥7 calendar days of shadow operation with heartbeat continuity (no gap
exceeding the dead-man threshold = 90s, which would indicate a service crash).

Measured from: `state.json._shadowStart` to `state.json.heartbeatAt`. If state.json
is absent, falls back to the span of audit.jsonl timestamps (underestimates window
if shadow ran healthily with no failure events).

**Pass criterion:** `(heartbeatAt - _shadowStart) / 86400000 ≥ 7`.

---

## Running the analyzer

```bash
# On arcana-dev as dev user
cd "/home/dev/arcanada/Projects/Model Connector/code/watcher"

node deploy/evidence-analyzer.js \
  --audit /var/lib/model-connector-watcher/audit.jsonl \
  --state /var/lib/model-connector-watcher/state.json \
  --window-days 7
```

**Exit codes:**
- `0` = all thresholds met (PASS)
- `1` = one or more thresholds failed (FAIL — extend window or investigate)
- `2` = error reading input files

---

## Dry-run (synthetic fixture verification)

The fixture generator and dry-run are located in `watcher/deploy/test-fixtures/`:

```bash
cd "/home/dev/arcanada/Projects/Model Connector/code/watcher"

# Generate 8-day fixture with 2 pairs, 3 genuine burst outages, 1 isolated proxy-FP
node deploy/test-fixtures/gen-fixtures.js

# Run the analyzer against the fixture
node deploy/evidence-analyzer.js \
  --audit /tmp/conn-0230-fixture-audit.jsonl \
  --state /tmp/conn-0230-fixture-state.json \
  --window-days 7
```

**Expected output:** VERDICT: PASS with all 7 checks green, 3.7% FP for pair 0 (the
isolated event at cycle 500 → within <5% threshold), 0% for pair 1, 0 flaps/day.

**Verified:** dry-run confirmed passing with correct metrics on 2026-06-22.

---

## What counts as a CONN-0227 expectation closure

When the analyzer exits 0 AND `sudo cat /var/lib/model-connector-watcher/audit.jsonl | jq 'select(.fix_applied == true)'` returns empty output:

- **CONN-0227 #3 (catalog re-fetch):** Confirmed closed if ≥1 catalog refresh cycle ran
  (check Ops Bot events for catalog-diff type OR journald for `refreshCatalogIfDue`).
- **CONN-0227 #5 (AAL L3 runtime proof):** Confirmed closed: window ≥7 days + zero
  mutation events (`fix_applied=true` = empty) = the declared L3 envelope was respected.

Both closures are CONN-0230 [OG] items (statistical axis) and are NOT closeable by the
autonomous phase.

---

## V-AC evidence map

| V-AC | Metric | Source | Gate |
|------|--------|--------|------|
| V-AC-6 | ≥500 samples/pair | time-derived from state.json window | PASS if window ≥7d |
| V-AC-7 | FP rate <5% | audit.jsonl proxy-isolated count / total | PASS if rate <0.05 and N≥20 |
| V-AC-8 | Flap ≤1/day avg, max≤2 | audit.jsonl state-transition reconstruction | PASS if avgPerDay≤1 and singleDayMax≤2 |
| V-AC-9 | Zero mutation events | `jq 'select(.fix_applied==true)' audit.jsonl` | PASS if empty |
| V-AC-10 | ≥1 catalog refresh cycle | Ops Bot events / journald `refreshCatalogIfDue` | Operator manual check |
