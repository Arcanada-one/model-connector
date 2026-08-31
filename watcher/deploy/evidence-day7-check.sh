#!/usr/bin/env bash
# CONN-0230 day-7 evidence check: run analyzer, capture verdict, post to Ops Bot.
set -uo pipefail
AUDIT=/var/lib/model-connector-watcher/audit.jsonl
STATE=/var/lib/model-connector-watcher/state.json
ANALYZER=/opt/model-connector-watcher/tools/evidence-analyzer.js
OUTDIR=/var/lib/model-connector-watcher/evidence
ENVFILE=/etc/model-connector-watcher/watcher.env
mkdir -p "$OUTDIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
REPORT="$OUTDIR/evidence-day7-$STAMP.txt"

node "$ANALYZER" --audit "$AUDIT" --state "$STATE" > "$REPORT" 2>&1
ANALYZER_EXIT=$?

VERDICT=$(grep -m1 "^VERDICT:" "$REPORT" | sed 's/VERDICT: //' || echo "UNKNOWN")
echo "[$(date -u +%FT%TZ)] CONN-0230 day-7 evidence: VERDICT=$VERDICT exit=$ANALYZER_EXIT report=$REPORT" >> "$OUTDIR/day7-runlog.txt"

# Post to Ops Bot (category info if PASS, warning if FAIL)
if [[ -f "$ENVFILE" ]]; then
  set -a
  # shellcheck source=/dev/null  # operator-provisioned env file, absent from the repo
  . "$ENVFILE"
  set +a
  CAT="info"; [[ "$VERDICT" != "PASS" ]] && CAT="warning"
  BODY=$(head -c 3500 "$REPORT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '"see report on host"')
  curl -s -o /dev/null -w "opsbot-post=%{http_code}\n" --max-time 15 -X POST https://ops.arcanada.ai/events \
    -H "authorization: Bearer ${OPSBOT_TOKEN}" -H "content-type: application/json" \
    -d "{\"category\":\"$CAT\",\"agent\":\"model-connector-watcher\",\"title\":\"CONN-0230 7-day shadow evidence: $VERDICT\",\"body\":$BODY,\"dedup_key\":\"conn-0230-day7-evidence\"}" \
    >> "$OUTDIR/day7-runlog.txt" 2>&1
fi
exit 0
