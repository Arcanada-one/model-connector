#!/usr/bin/env bash
# CONN-0230 watcher health self-check. Alerts Ops Bot only on regression.
set -uo pipefail
ENVFILE=/etc/model-connector-watcher/watcher.env
STATE=/var/lib/model-connector-watcher/state.json
AUDIT=/var/lib/model-connector-watcher/audit.jsonl
# Overridable only so the specs can observe the verdict without writing under
# /var; production callers pass nothing and get the path they always had.
LOG="${SELFCHECK_LOG:-/var/lib/model-connector-watcher/evidence/selfcheck.log}"
# Where the previous run's restart counter is remembered. NRestarts is cumulative,
# so the only way to ask "did it restart since I last looked" is to keep the
# previous reading. Overridable so the specs can drive this without touching /var.
SELFCHECK_STATE="${SELFCHECK_STATE:-/var/lib/model-connector-watcher/selfcheck-state}"
UNIT="${SELFCHECK_UNIT:-model-connector-watcher.service}"
mkdir -p "$(dirname "$LOG")"
problems=()

# 1. service active?
active=$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)
[[ "$active" != "active" ]] && problems+=("service not active: $active")

# 2. restart loop?
#
# NRestarts is a lifetime counter for the unit: it never decreases and systemd
# never resets it on its own. Comparing it to a fixed ceiling therefore produces
# an alarm that can NEVER clear -- once the unit has restarted four times it will
# report a "restart loop" for the rest of its life, including while it has been
# running untouched for ten days. A signal that cannot return to normal is not a
# signal; it is noise that trains the reader to ignore the channel.
#
# Measure the RATE instead: how many restarts happened since the previous
# self-check. The threshold is unchanged in spirit -- more than three restarts
# inside one 6h window is a loop -- but it is now applied to the delta, so a unit
# that stops restarting goes quiet on the next run.
#
# The first run after this lands has no remembered reading. It records the
# current value and reports nothing, because a lifetime counter says nothing
# about the window that just passed. Treating an unknown baseline as zero would
# resurrect the very false alarm this replaces.
nrestarts=$(systemctl show "$UNIT" -p NRestarts --value 2>/dev/null || echo 0)
[[ "$nrestarts" =~ ^[0-9]+$ ]] || nrestarts=0
prev_restarts=""
if [[ -f "$SELFCHECK_STATE" ]]; then
  prev_restarts=$(grep -oE '^nrestarts=[0-9]+$' "$SELFCHECK_STATE" | head -1 | cut -d= -f2)
fi
if [[ -n "$prev_restarts" ]]; then
  delta=$(( nrestarts - prev_restarts ))
  # A counter that went backwards means the unit was reset or reinstalled; that
  # is a fresh baseline, not a negative rate.
  [[ "$delta" -lt 0 ]] && delta=0
  [[ "$delta" -gt 3 ]] && problems+=("restart loop: $delta restarts since last check (NRestarts=$nrestarts)")
else
  delta="baseline"
fi
# Record the reading for the next run, whatever the verdict. Written atomically so
# a self-check killed mid-write cannot leave a truncated baseline behind, which
# would silently reset the window.
if mkdir -p "$(dirname "$SELFCHECK_STATE")" 2>/dev/null; then
  tmp="$SELFCHECK_STATE.$$"
  if printf 'nrestarts=%s\ncheckedAt=%s\n' "$nrestarts" "$(date -u +%FT%TZ)" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$SELFCHECK_STATE" 2>/dev/null || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
fi

# 3. heartbeat stale? (>5 min old = watcher stuck)
if [[ -f "$STATE" ]]; then
  hb=$(grep -oE '"heartbeatAt":"[^"]+"' "$STATE" | sed 's/.*:"//;s/"//')
  if [[ -n "$hb" ]]; then
    age=$(( $(date -u +%s) - $(date -u -d "$hb" +%s 2>/dev/null || echo 0) ))
    [[ "$age" -gt 300 ]] && problems+=("heartbeat stale: ${age}s old")
  fi
fi

# 4. health endpoint?
hc=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 http://127.0.0.1:3911/ 2>/dev/null || echo 000)
[[ "$hc" != "200" ]] && problems+=("health endpoint $hc")

# 5. FP resurgence — windowed FP rate via analyzer (gate is informational here)
verdict=$(node /opt/model-connector-watcher/tools/evidence-analyzer.js --audit "$AUDIT" --state "$STATE" 2>/dev/null | grep -oE 'FP_RATE.*\([0-9.]+%\)' | head -1 || echo "")

ts=$(date -u +%FT%TZ)
if [[ ${#problems[@]} -eq 0 ]]; then
  echo "[$ts] OK active=$active restarts=$nrestarts delta=$delta health=$hc fp=[$verdict]" >> "$LOG"
  exit 0
fi
msg="watcher health regression: ${problems[*]}"
echo "[$ts] ALERT $msg" >> "$LOG"
if [[ -f "$ENVFILE" ]]; then
  set -a
  # shellcheck source=/dev/null  # operator-provisioned env file, absent from the repo
  . "$ENVFILE"
  set +a
  curl -s -o /dev/null -w "opsbot=%{http_code}\n" --max-time 12 -X POST https://ops.arcanada.ai/events \
    -H "authorization: Bearer ${OPSBOT_TOKEN}" -H "content-type: application/json" \
    -d "{\"category\":\"warning\",\"agent\":\"model-connector-watcher\",\"title\":\"CONN-0230 watcher health regression\",\"body\":$(printf '%s' "$msg" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))'),\"dedup_key\":\"conn-0230-health-regression\"}" \
    >> "$LOG" 2>&1
fi
exit 0
