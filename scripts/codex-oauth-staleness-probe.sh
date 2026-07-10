#!/usr/bin/env bash
# codex-oauth-staleness-probe.sh — alert when the codex-cli OAuth blob in
# Vault hasn't been refreshed recently. (CONN-0218)
#
# Two prior incidents (CONN-0072, CONN-0217) both surfaced OAuth-adjacent
# staleness reactively, via a live 401/execution_error from codex CLI. This
# probe closes the gap proactively: read the CURRENT KV-v2 version's
# created_time for arcanada/prod/env/codex-cli, compute days elapsed, and
# alert Ops Bot ahead of expiry instead of after.
#
# Read-only — uses the same AppRole read-role creds as
# codex-sidecar-entrypoint.sh (VAULT_ROLE_ID/VAULT_SECRET_ID). Never touches
# codex-oauth-writeback.sh's dedicated write-only role.
#
# Usage:
#   codex-oauth-staleness-probe.sh [options]
#
# Options:
#   --vault-path <path>   Vault KV-v2 path (default: ${VAULT_KV_PATH:-arcanada/prod/env/codex-cli})
#   --metric-file <path>  Prometheus textfile-collector output
#                          (default: ${METRIC_FILE:-/var/lib/node_exporter/textfile_collector/codex_oauth_blob_age.prom})
#   --state-dir <path>    dedup state dir (default: ${STATE_DIR:-/tmp/codex-oauth-staleness-state})
#   --warn-days <n>       warning threshold (default: 10)
#   --crit-days <n>       critical threshold (default: 14)
#
# Required env:
#   VAULT_ADDR       — Vault server address
#   VAULT_ROLE_ID    — AppRole role-id (READ role)
#   VAULT_SECRET_ID  — AppRole secret-id
#
# Optional env:
#   OPSBOT_URL       — default https://ops.arcanada.one/events
#   OPSBOT_API_KEY   — Ops Bot Bearer key; unset = probe still runs, logs the
#                      age, writes the metric, but skips the alert POST
#                      (fail-open on notification, never fail-open on the
#                      probe itself)
#
# Intended invocation: cron/systemd-timer, once daily, on arcana-prod. This
# script only reads; scheduling it is a deploy action and out of scope here
# (authored, not run) — see deploy/codex-oauth-staleness-probe.timer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/vault-kv-version.sh
. "${SCRIPT_DIR}/lib/vault-kv-version.sh"

log() { printf '[oauth-staleness] %s\n' "$*" >&2; }

VAULT_PATH="${VAULT_KV_PATH:-arcanada/prod/env/codex-cli}"
METRIC_FILE="${METRIC_FILE:-/var/lib/node_exporter/textfile_collector/codex_oauth_blob_age.prom}"
STATE_DIR="${STATE_DIR:-/tmp/codex-oauth-staleness-state}"
WARN_DAYS=10
CRIT_DAYS=14
OPSBOT_URL="${OPSBOT_URL:-https://ops.arcanada.one/events}"

while [ $# -gt 0 ]; do
    case "$1" in
        --vault-path) VAULT_PATH="$2"; shift 2 ;;
        --metric-file) METRIC_FILE="$2"; shift 2 ;;
        --state-dir) STATE_DIR="$2"; shift 2 ;;
        --warn-days) WARN_DAYS="$2"; shift 2 ;;
        --crit-days) CRIT_DAYS="$2"; shift 2 ;;
        *) log "Unknown argument: $1"; exit 2 ;;
    esac
done

: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_ROLE_ID:?VAULT_ROLE_ID is required}"
: "${VAULT_SECRET_ID:?VAULT_SECRET_ID is required}"

mkdir -p "${STATE_DIR}"
mkdir -p "$(dirname "${METRIC_FILE}")" 2>/dev/null || true

log "AppRole login at ${VAULT_ADDR} (role-id redacted)"
VAULT_TOKEN="$(timeout 30 vault write -field=token auth/approle/login \
    role_id="${VAULT_ROLE_ID}" secret_id="${VAULT_SECRET_ID}")"
export VAULT_TOKEN
unset VAULT_ROLE_ID VAULT_SECRET_ID

RAW="$(timeout 30 vault kv get -format=json "${VAULT_PATH}" 2>/dev/null)" || {
    log "ERROR: cannot read ${VAULT_PATH} from Vault — skipping this run (fail-closed on probe, no metric written)."
    unset VAULT_TOKEN
    exit 1
}
unset VAULT_TOKEN

CREATED_TIME="$(vault_kv_metadata_field "${RAW}" created_time)"
CURRENT_VERSION="$(vault_kv_metadata_field "${RAW}" version)"

if [ -z "${CREATED_TIME}" ]; then
    log "ERROR: could not extract metadata.created_time from Vault response — skipping this run."
    exit 1
fi

NOW_EPOCH="$(date -u +%s)"
CREATED_EPOCH="$(date -u -d "${CREATED_TIME}" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%S' "${CREATED_TIME%%.*}" +%s 2>/dev/null)" || {
    log "ERROR: could not parse created_time '${CREATED_TIME}' — skipping this run."
    exit 1
}
AGE_DAYS=$(( (NOW_EPOCH - CREATED_EPOCH) / 86400 ))

log "vault-ver=${CURRENT_VERSION:-unknown} created_time=${CREATED_TIME} age_days=${AGE_DAYS}"

# Prometheus textfile-collector metric (best-effort — non-fatal if the
# directory doesn't exist, e.g. node_exporter not installed on this host).
if {
    printf '# HELP codex_oauth_blob_age_days Days since the codex-cli OAuth blob in Vault was last written.\n'
    printf '# TYPE codex_oauth_blob_age_days gauge\n'
    printf 'codex_oauth_blob_age_days %s\n' "${AGE_DAYS}"
} > "${METRIC_FILE}.tmp" 2>/dev/null; then
    mv "${METRIC_FILE}.tmp" "${METRIC_FILE}" 2>/dev/null || log "Warning: could not move metric file into place ${METRIC_FILE} (non-fatal)."
else
    log "Warning: could not write metric file ${METRIC_FILE} (non-fatal)."
fi

CATEGORY=""
if [ "${AGE_DAYS}" -ge "${CRIT_DAYS}" ]; then
    CATEGORY="critical"
elif [ "${AGE_DAYS}" -ge "${WARN_DAYS}" ]; then
    CATEGORY="warning"
fi

if [ -z "${CATEGORY}" ]; then
    if [ -f "${STATE_DIR}/notified" ]; then
        log "[RECOVER] age back under threshold (${AGE_DAYS}d < ${WARN_DAYS}d)"
        rm -f "${STATE_DIR}/notified"
    fi
    exit 0
fi

DEDUP_KEY="codex-oauth-staleness-${CATEGORY}-$(date -u +%Y-%m-%d)"
BODY=$(printf '{"category":"%s","component":"codex-oauth","body":"codex-cli OAuth blob age=%sd >= %sd threshold; operator codex login needed (path=%s)","dedup_key":"%s"}' \
    "${CATEGORY}" "${AGE_DAYS}" "$([ "${CATEGORY}" = critical ] && echo "${CRIT_DAYS}" || echo "${WARN_DAYS}")" "${VAULT_PATH}" "${DEDUP_KEY}")

if [ -z "${OPSBOT_API_KEY:-}" ]; then
    log "[OPSBOT] skip: OPSBOT_API_KEY not set (category=${CATEGORY} age=${AGE_DAYS}d)"
    exit 0
fi

HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "${OPSBOT_URL}" \
    -H "Authorization: Bearer ${OPSBOT_API_KEY}" \
    -H "Content-Type: application/json" \
    --max-time 15 \
    -d "${BODY}" || echo "000")"

if [ "${HTTP_CODE}" = "200" ] || [ "${HTTP_CODE}" = "201" ] || [ "${HTTP_CODE}" = "202" ]; then
    touch "${STATE_DIR}/notified"
    log "[OPSBOT] notified http=${HTTP_CODE} category=${CATEGORY} dedup=${DEDUP_KEY}"
else
    log "[OPSBOT] post failed http=${HTTP_CODE}"
fi
