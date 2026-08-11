---
doc_type: runbook
task_id: CONN-0230
parent: CONN-0227
created: 2026-06-22
status: ready-for-operator
---

# CONN-0230 — Observability and Alert Wiring Checklist

This document enumerates every alert type, log stream, health endpoint, and observability
signal the operator monitors during the 7-day shadow evidence window.

---

## Alert delivery path

All alerts go through **Ops Bot** (AGENT-0010):
- URL: `opsbot.base_url` in `config.yaml` → `https://ops.arcanada.ai/events`
- Auth: `Authorization: Bearer ${OPSBOT_TOKEN}` (from `watcher.env`)
- Dedup window: `alerting.dedup_window_ms = 900000` (15 minutes) — identical events within
  15 min are silently dropped by the client. This prevents alert storms.
- Secret redaction: all token/key/password fields are replaced with `[REDACTED]` before
  delivery and before writing to audit.jsonl.

---

## Event types (as-built, from `src/main.ts` `emitAlert` calls)

Every alert event the watcher emits includes: `provider`, `model`, `failure_class`,
`attempted_action`, `blocked_action`, `outcome`, `audit_ref`, and a redacted `evidence`
snapshot.

| Event type | When emitted | Shadow outcome | What to look for |
|------------|--------------|----------------|-----------------|
| **detection / blocked-mutation** | `circuit_open` failure class detected; recovery policy decided `reset_circuit` but `circuit_reset_enabled=false` | `outcome=blocked_by_config`, `blocked_action=reset_circuit` | `blocked_action` field in Ops Bot event |
| **detection / outage** | `provider_outage`, `rate_or_quota`, `authentication`, `billing` class detected | `outcome=blocked_by_config` (mutation not eligible) | `failure_class` + `outcome` in event |
| **catalog-anomaly** | `CatalogSync.reconcile()` returns `added`, `changed`, or `missing` models | No write (`write_enabled=false`); `writeAttempted=false` | Ops Bot catalog-diff log line; audit.jsonl from catalog-sync code path |
| **heartbeat** | Every `alerting.heartbeat_interval_ms = 30000ms` (30s) | Always emitted | Regular heartbeat events in Ops Bot feed |
| **dead-man** | `Deadman.check()` triggers when `state.json` heartbeatAt is stale by `3 × 30s = 90s` | Deadman CLI emits Ops Bot alert | Dead-man alert in feed + `model-connector-watcher-deadman` service invocation |

> **Note on heartbeat cadence:** The heartbeat is emitted inside the dedup window (30s
> heartbeat interval = same dedup key every 30s within the 15-min window). In practice,
> after the first heartbeat delivery, subsequent heartbeats within the 15-min window are
> silently deduped. The operator will see approximately 1 heartbeat event per 15 minutes
> in the Ops Bot feed, not every 30 seconds.

---

## Health endpoint

- **URL**: `http://127.0.0.1:3911/` (loopback only — do NOT expose externally)
- **Response**: `{ "status": "ok" }` or `{ "status": "degraded" }`
  - `ok`: the last observation cycle completed with all 4 MC calls succeeded
  - `degraded`: one or more MC calls failed in the last cycle (not necessarily a real
    outage — could be a transient network hiccup)
- **Check**:
  ```bash
  curl -sf http://127.0.0.1:3911/ | jq .status
  ```

---

## Log streams

### journald (primary)

```bash
# Live stream
sudo journalctl -u model-connector-watcher.service -f

# Last 50 lines
sudo journalctl -u model-connector-watcher.service -n 50 --no-pager

# Search for cycle completions
sudo journalctl -u model-connector-watcher.service --no-pager | grep "cycle completed"

# Search for shadow invariant violations (should be empty)
sudo journalctl -u model-connector-watcher.service --no-pager | grep "fix_applied.*true"

# Dead-man timer invocations
sudo journalctl -u model-connector-watcher-deadman.service --no-pager
```

### audit.jsonl (failure events only)

Path: `/var/lib/model-connector-watcher/audit.jsonl`

```bash
# Read all audit records
sudo cat /var/lib/model-connector-watcher/audit.jsonl | jq .

# Check for any mutation events (must be empty in shadow)
sudo cat /var/lib/model-connector-watcher/audit.jsonl | \
  jq 'select(.fix_applied == true)'
# Expected: empty output

# Count by failure class
sudo cat /var/lib/model-connector-watcher/audit.jsonl | \
  jq -r .failure_class | sort | uniq -c | sort -rn

# Count by provider:model
sudo cat /var/lib/model-connector-watcher/audit.jsonl | \
  jq -r '[.provider, .model] | join(":")' | sort | uniq -c | sort -rn
```

### state.json (heartbeat continuity)

Path: `/var/lib/model-connector-watcher/state.json`

```bash
sudo cat /var/lib/model-connector-watcher/state.json | jq .
# Expected: { "heartbeatAt": "<recent ISO timestamp>", "lastCycleOk": true }
# If heartbeatAt is >90s old, the dead-man has fired (check dead-man logs)
```

---

## Dead-man monitoring

The dead-man is a separate `Type=oneshot` systemd service triggered by a timer every 30s.
It reads `state.json` and checks if `heartbeatAt` is older than `3 × 30s = 90s`.
If stale → emits a Ops Bot alert.

```bash
# Timer status (should show "active (running)" between ticks)
sudo systemctl status model-connector-watcher-deadman.timer

# Recent dead-man invocations
sudo journalctl -u model-connector-watcher-deadman.service -n 10 --no-pager
```

**What a dead-man event means:** the main watcher process stopped heartbeating.
Check `systemctl status model-connector-watcher` immediately — it may have crashed.

---

## Shadow invariant audit (run daily)

Verify no mutation events occurred:

```bash
# Zero fix_applied=true in audit log (shadow invariant)
MUTATIONS=$(sudo cat /var/lib/model-connector-watcher/audit.jsonl 2>/dev/null | \
  jq 'select(.fix_applied == true)' | wc -l)
echo "Mutation events: ${MUTATIONS}"
# Expected: 0
```

---

## Evidence collection (at 7-day mark)

At the end of the shadow window, run the evidence analyzer to produce the V-AC-6..10
verdict:

```bash
# Ensure you have the analyzer on arcana-dev
WATCHER_DIR="/home/dev/arcanada/Projects/Model Connector/code/watcher"

node "${WATCHER_DIR}/deploy/evidence-analyzer.js" \
  --audit /var/lib/model-connector-watcher/audit.jsonl \
  --state /var/lib/model-connector-watcher/state.json \
  --window-days 7
```

**Exit code 0** = all thresholds met = CONN-0227 expectations #3 and #5 can be closed
as DONE in the next `/dr-archive` run.

**Exit code 1** = one or more thresholds not met = extend the window or investigate
the failure categories.

See full threshold definitions and methodology in
`documentation/runbooks/conn-0230-evidence-harness.md`.
