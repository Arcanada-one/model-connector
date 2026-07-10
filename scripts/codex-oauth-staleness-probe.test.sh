#!/usr/bin/env bash
# Unit tests for codex-oauth-staleness-probe.sh (CONN-0218).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROBE_SCRIPT="${SCRIPT_DIR}/codex-oauth-staleness-probe.sh"

TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_BASE}"' EXIT

fail=0
assert_exit() {
    local label="$1" want="$2" got="$3"
    if [ "${want}" = "${got}" ]; then
        printf 'ok   %s (exit=%s)\n' "${label}" "${got}"
    else
        printf 'FAIL %s: want exit=%s got exit=%s\n' "${label}" "${want}" "${got}"
        fail=1
    fi
}
assert_log_contains() {
    local label="$1" needle="$2" file="$3"
    if grep -q "${needle}" "${file}" 2>/dev/null; then
        printf 'ok   %s (log contains "%s")\n' "${label}" "${needle}"
    else
        local content
        content="$(cat "${file}" 2>/dev/null || echo '(empty)')"
        printf 'FAIL %s: log does not contain "%s"\n  log: %s\n' "${label}" "${needle}" "${content}"
        fail=1
    fi
}
assert_log_not_contains() {
    local label="$1" needle="$2" file="$3"
    if grep -q "${needle}" "${file}" 2>/dev/null; then
        printf 'FAIL %s: log unexpectedly contains "%s"\n' "${label}" "${needle}"
        fail=1
    else
        printf 'ok   %s (log does not contain "%s")\n' "${label}" "${needle}"
    fi
}

# days_ago <n> -> RFC3339 timestamp n days before now (nanosecond precision,
# matching real Vault output).
days_ago() {
    date -u -d "-$1 days" +"%Y-%m-%dT%H:%M:%S.000000000Z"
}

# Build a mock vault binary. Reads VAULT_MOCK_CREATED_TIME / VAULT_MOCK_VERSION
# / VAULT_MOCK_UNREACHABLE (all optional).
build_mock_vault() {
    local mock_dir="$1"
    mkdir -p "${mock_dir}"
    cat > "${mock_dir}/vault" << EOF
#!/usr/bin/env bash
if [ "\${VAULT_MOCK_UNREACHABLE:-0}" = "1" ]; then
    echo "Error: Vault unreachable" >&2
    exit 1
fi
if [ "\$1" = "write" ]; then
    printf 'mock-read-vault-token\n'
    exit 0
fi
if [ "\$1" = "kv" ] && [ "\$2" = "get" ]; then
    ver="\${VAULT_MOCK_VERSION:-3}"
    created="\${VAULT_MOCK_CREATED_TIME:-2026-01-01T00:00:00.000000000Z}"
    printf '{"data":{"data":{"oauth_credentials":"stub"},"metadata":{"created_time":"%s","version":%s,"destroyed":false}}}\n' "\${created}" "\${ver}"
    exit 0
fi
exit 0
EOF
    chmod +x "${mock_dir}/vault"
}

build_mock_timeout() {
    local mock_dir="$1"
    cat > "${mock_dir}/timeout" << 'EOF'
#!/usr/bin/env bash
shift; exec "$@"
EOF
    chmod +x "${mock_dir}/timeout"
}

# Mock curl — records every invocation's -d payload and returns
# CURL_MOCK_HTTP_CODE (default 200).
build_mock_curl() {
    local mock_dir="$1"
    cat > "${mock_dir}/curl" << 'EOF'
#!/usr/bin/env bash
LOG="${CURL_MOCK_LOG:-/dev/null}"
printf '%s\n' "$*" >> "${LOG}"
printf '%s' "${CURL_MOCK_HTTP_CODE:-200}"
exit 0
EOF
    chmod +x "${mock_dir}/curl"
}

run_probe() {
    local dir="$1"; shift
    export CURL_MOCK_LOG="${dir}/curl.log"
    build_mock_vault "${dir}/mock-bin"
    build_mock_timeout "${dir}/mock-bin"
    build_mock_curl "${dir}/mock-bin"
    local old_path="${PATH}"
    export PATH="${dir}/mock-bin:${old_path}"
    VAULT_ADDR="http://mock-vault:8200" \
    VAULT_ROLE_ID="test-role-id" \
    VAULT_SECRET_ID="test-secret-id" \
    METRIC_FILE="${dir}/metric.prom" \
    STATE_DIR="${dir}/state" \
    bash "${PROBE_SCRIPT}" "$@" 2>&1
    local rc=$?
    export PATH="${old_path}"
    unset CURL_MOCK_LOG
    return "${rc}"
}

# ---------------------------------------------------------------------------
# P-1: healthy age (2 days) — no alert, metric written, exit 0.
# ---------------------------------------------------------------------------
d="${TMPDIR_BASE}/p1"; mkdir -p "${d}"
created_time="$(days_ago 2)"
export VAULT_MOCK_CREATED_TIME="${created_time}" OPSBOT_API_KEY="k"
set +e
run_probe "${d}" > "${d}/out.log" 2>&1
rc=$?; set -e
unset VAULT_MOCK_CREATED_TIME OPSBOT_API_KEY
assert_exit "P-1 healthy exit 0" 0 "${rc}"
assert_log_not_contains "P-1 no opsbot post" "\[OPSBOT\] notified" "${d}/out.log"
if grep -q 'codex_oauth_blob_age_days 2' "${d}/metric.prom"; then echo "ok   P-1 metric age=2"; else echo "FAIL P-1 metric age=2 missing"; cat "${d}/metric.prom"; fail=1; fi

# ---------------------------------------------------------------------------
# P-2: warning age (11 days, >= default --warn-days 10) — alerts, category warning.
# ---------------------------------------------------------------------------
d="${TMPDIR_BASE}/p2"; mkdir -p "${d}"
created_time="$(days_ago 11)"
export VAULT_MOCK_CREATED_TIME="${created_time}" OPSBOT_API_KEY="k"
set +e
run_probe "${d}" > "${d}/out.log" 2>&1
rc=$?; set -e
unset VAULT_MOCK_CREATED_TIME OPSBOT_API_KEY
assert_exit "P-2 exit 0" 0 "${rc}"
assert_log_contains "P-2 notified" "\[OPSBOT\] notified http=200 category=warning" "${d}/out.log"
if grep -q '"category":"warning"' "${d}/curl.log"; then echo "ok   P-2 payload category=warning"; else echo "FAIL P-2 payload missing category=warning"; cat "${d}/curl.log"; fail=1; fi

# ---------------------------------------------------------------------------
# P-3: critical age (15 days, >= default --crit-days 14) — alerts, category critical.
# ---------------------------------------------------------------------------
d="${TMPDIR_BASE}/p3"; mkdir -p "${d}"
created_time="$(days_ago 15)"
export VAULT_MOCK_CREATED_TIME="${created_time}" OPSBOT_API_KEY="k"
set +e
run_probe "${d}" > "${d}/out.log" 2>&1
rc=$?; set -e
unset VAULT_MOCK_CREATED_TIME OPSBOT_API_KEY
assert_exit "P-3 exit 0" 0 "${rc}"
assert_log_contains "P-3 notified" "\[OPSBOT\] notified http=200 category=critical" "${d}/out.log"

# ---------------------------------------------------------------------------
# P-4: stale but no OPSBOT_API_KEY set — logs skip, does not attempt curl.
# ---------------------------------------------------------------------------
d="${TMPDIR_BASE}/p4"; mkdir -p "${d}"
created_time="$(days_ago 20)"
export VAULT_MOCK_CREATED_TIME="${created_time}"
set +e
run_probe "${d}" > "${d}/out.log" 2>&1
rc=$?; set -e
unset VAULT_MOCK_CREATED_TIME
assert_exit "P-4 exit 0" 0 "${rc}"
assert_log_contains "P-4 skip logged" "\[OPSBOT\] skip: OPSBOT_API_KEY not set" "${d}/out.log"
if [ ! -s "${d}/curl.log" ]; then echo "ok   P-4 curl never invoked"; else echo "FAIL P-4 curl.log unexpectedly non-empty"; fail=1; fi

# ---------------------------------------------------------------------------
# P-5: Vault unreachable — probe fails closed (exit 1), no metric written.
# ---------------------------------------------------------------------------
d="${TMPDIR_BASE}/p5"; mkdir -p "${d}"
export VAULT_MOCK_UNREACHABLE=1 OPSBOT_API_KEY="k"
set +e
run_probe "${d}" > "${d}/out.log" 2>&1
rc=$?; set -e
unset VAULT_MOCK_UNREACHABLE OPSBOT_API_KEY
assert_exit "P-5 fail-closed exit 1" 1 "${rc}"
if [ ! -f "${d}/metric.prom" ]; then echo "ok   P-5 no metric written"; else echo "FAIL P-5 metric unexpectedly written"; fail=1; fi

# ---------------------------------------------------------------------------
# P-6: --warn-days / --crit-days overrides are honoured.
# ---------------------------------------------------------------------------
d="${TMPDIR_BASE}/p6"; mkdir -p "${d}"
created_time="$(days_ago 3)"
export VAULT_MOCK_CREATED_TIME="${created_time}" OPSBOT_API_KEY="k"
set +e
run_probe "${d}" --warn-days 2 --crit-days 5 > "${d}/out.log" 2>&1
rc=$?; set -e
unset VAULT_MOCK_CREATED_TIME OPSBOT_API_KEY
assert_exit "P-6 exit 0" 0 "${rc}"
assert_log_contains "P-6 warn honoured at custom threshold" "\[OPSBOT\] notified http=200 category=warning" "${d}/out.log"

echo "---"
if [ "${fail}" = "0" ]; then
    echo "ALL PASS"
    exit 0
else
    echo "SOME FAILED"
    exit 1
fi
