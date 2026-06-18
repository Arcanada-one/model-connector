#!/usr/bin/env bash
# Unit tests for codex-oauth-writeback.sh (CONN-0222 Phases 2+3).
# Tests W-1..W-5 (CAS writeback) + S-1..S-3 (single-flight / lock).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRITEBACK_SCRIPT="${SCRIPT_DIR}/codex-oauth-writeback.sh"

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
assert_eq() {
    local label="$1" want="$2" got="$3"
    if [ "${want}" = "${got}" ]; then
        printf 'ok   %s (value=%s)\n' "${label}" "${got}"
    else
        printf 'FAIL %s: want=%s got=%s\n' "${label}" "${want}" "${got}"
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

# ---------------------------------------------------------------------------
# Build a mock vault binary.
# Mock reads these exported vars:
#   VAULT_MOCK_CURRENT_VER   — returned by metadata get
#   VAULT_MOCK_CAS_MATCH_VER — put succeeds only when cas matches this value
#   VAULT_MOCK_UNREACHABLE   — if "1", put exits 1 (write failure)
#   VAULT_MOCK_LOG           — all calls are appended here
# ---------------------------------------------------------------------------
build_mock_vault() {
    local mock_dir="$1"
    mkdir -p "${mock_dir}"
    cat > "${mock_dir}/vault" << 'EOF'
#!/usr/bin/env bash
LOG="${VAULT_MOCK_LOG:-/dev/null}"
printf '%s\n' "$*" >> "${LOG}"
if [ "$1" = "kv" ] && [ "$2" = "metadata" ] && [ "$3" = "get" ]; then
    ver="${VAULT_MOCK_CURRENT_VER:-1}"
    printf '{"data":{"current_version":%s,"max_versions":5}}\n' "${ver}"
    exit 0
fi
if [ "$1" = "kv" ] && [ "$2" = "put" ]; then
    if [ "${VAULT_MOCK_UNREACHABLE:-0}" = "1" ]; then
        printf 'Error: Vault unreachable\n' >&2; exit 1
    fi
    cas_val=""
    for arg in "$@"; do case "${arg}" in -cas=*) cas_val="${arg#-cas=}" ;; esac; done
    match_ver="${VAULT_MOCK_CAS_MATCH_VER:-1}"
    if [ -n "${cas_val}" ] && [ "${cas_val}" != "${match_ver}" ]; then
        printf 'Error writing data: check-and-set parameter did not match the current version\n' >&2
        exit 2
    fi
    printf 'Success! Data written\n'; exit 0
fi
if [ "$1" = "kv" ] && [ "$2" = "get" ]; then
    printf '{"access_token":"fresh-vault-token","refresh_token":"rN_fresh"}\n'; exit 0
fi
exit 0
EOF
    chmod +x "${mock_dir}/vault"
}

# Run the writeback script with a mock vault. Exports VAULT_MOCK_LOG into env.
run_writeback() {
    local dir="$1"; shift
    export VAULT_MOCK_LOG="${dir}/vault.log"
    build_mock_vault "${dir}/mock-vault"
    local old_path="${PATH}"
    export PATH="${dir}/mock-vault:${old_path}"
    bash "${WRITEBACK_SCRIPT}" "$@" 2>&1
    local rc=$?
    export PATH="${old_path}"
    unset VAULT_MOCK_LOG
    return "${rc}"
}

# ---------------------------------------------------------------------------
# W-1: vault kv put is called with -cas=<ver>
# Scenario: auth.json present, marker=3, vault_ver=3 → CAS write with cas=3
# ---------------------------------------------------------------------------
W1="${TMPDIR_BASE}/w1"; mkdir -p "${W1}"
printf '{"access_token":"tok","refresh_token":"rA"}' > "${W1}/auth.json"
printf '3' > "${W1}/.vault-version"
export VAULT_MOCK_CURRENT_VER=3 VAULT_MOCK_CAS_MATCH_VER=3 VAULT_MOCK_UNREACHABLE=0

set +e
run_writeback "${W1}" \
    --auth-file "${W1}/auth.json" --vault-path "arcanada/prod/env/codex-cli" \
    --marker "${W1}/.vault-version" --lock "${W1}/.writeback.lock" --once >/dev/null
rc=$?; set -e
assert_exit "W-1 CAS write exits 0" 0 "${rc}"
assert_log_contains "W-1 vault put called with cas=" "kv put" "${W1}/vault.log"
assert_log_contains "W-1 -cas=3 in args" "cas=3" "${W1}/vault.log"

# ---------------------------------------------------------------------------
# W-2: CAS success → marker is written/updated
# ---------------------------------------------------------------------------
W2="${TMPDIR_BASE}/w2"; mkdir -p "${W2}"
printf '{"access_token":"tok2","refresh_token":"rB"}' > "${W2}/auth.json"
printf '5' > "${W2}/.vault-version"
export VAULT_MOCK_CURRENT_VER=5 VAULT_MOCK_CAS_MATCH_VER=5 VAULT_MOCK_UNREACHABLE=0

set +e
run_writeback "${W2}" \
    --auth-file "${W2}/auth.json" --vault-path "arcanada/prod/env/codex-cli" \
    --marker "${W2}/.vault-version" --lock "${W2}/.writeback.lock" --once >/dev/null
set -e
marker_val="$(cat "${W2}/.vault-version" 2>/dev/null)"
assert_eq "W-2 marker is set after CAS success" "5" "${marker_val}"

# ---------------------------------------------------------------------------
# W-3: CAS conflict → re-read from Vault, exactly 1 put, 1 get, no retry write
# Scenario: vault metadata returns ver=5, but another writer already advanced
# vault to ver=6 between our metadata read and put. We simulate this by having
# the mock accept ONLY cas=6 (reject cas=5).
# The local marker holds 5 so vault_kv_current_version returns 5.
# The put with cas=5 gets rejected (conflict); script must re-read (kv get) but
# NOT retry the put.
# ---------------------------------------------------------------------------
W3="${TMPDIR_BASE}/w3"; mkdir -p "${W3}"
printf '{"access_token":"tok3","refresh_token":"rC"}' > "${W3}/auth.json"
printf '5' > "${W3}/.vault-version"
# vault metadata still reports 5 (what we'd read), but CAS only succeeds at 6
# (another writer snuck in). The mock REJECTS cas=5.
export VAULT_MOCK_CURRENT_VER=5 VAULT_MOCK_CAS_MATCH_VER=6 VAULT_MOCK_UNREACHABLE=0

set +e
run_writeback "${W3}" \
    --auth-file "${W3}/auth.json" --vault-path "arcanada/prod/env/codex-cli" \
    --marker "${W3}/.vault-version" --lock "${W3}/.writeback.lock" --once >/dev/null
rc3=$?; set -e
assert_exit "W-3 CAS conflict exits 0 (re-read, not error)" 0 "${rc3}"
put_calls="$(grep -c "kv put" "${W3}/vault.log" 2>/dev/null || echo 0)"
get_calls="$(grep -c "kv get" "${W3}/vault.log" 2>/dev/null || echo 0)"
assert_eq "W-3 exactly 1 put attempt (no retry)" "1" "${put_calls}"
assert_eq "W-3 re-read (kv get) called after conflict" "1" "${get_calls}"

# ---------------------------------------------------------------------------
# W-4: idempotent — same content mtime-touched → safe (put called, CAS guards)
# ---------------------------------------------------------------------------
W4="${TMPDIR_BASE}/w4"; mkdir -p "${W4}"
printf '{"access_token":"same","refresh_token":"rSame"}' > "${W4}/auth.json"
printf '2' > "${W4}/.vault-version"
touch "${W4}/auth.json"
export VAULT_MOCK_CURRENT_VER=2 VAULT_MOCK_CAS_MATCH_VER=2 VAULT_MOCK_UNREACHABLE=0

set +e
run_writeback "${W4}" \
    --auth-file "${W4}/auth.json" --vault-path "arcanada/prod/env/codex-cli" \
    --marker "${W4}/.vault-version" --lock "${W4}/.writeback.lock" --once >/dev/null
rc4=$?; set -e
assert_exit "W-4 idempotent put exits 0" 0 "${rc4}"

# ---------------------------------------------------------------------------
# W-5: Vault unreachable on write → non-zero exit, local token unchanged
# ---------------------------------------------------------------------------
W5="${TMPDIR_BASE}/w5"; mkdir -p "${W5}"
ORIG='{"access_token":"local-fresh","refresh_token":"rLocal"}'
printf '%s' "${ORIG}" > "${W5}/auth.json"
printf '1' > "${W5}/.vault-version"
export VAULT_MOCK_CURRENT_VER=1 VAULT_MOCK_CAS_MATCH_VER=1 VAULT_MOCK_UNREACHABLE=1

set +e
run_writeback "${W5}" \
    --auth-file "${W5}/auth.json" --vault-path "arcanada/prod/env/codex-cli" \
    --marker "${W5}/.vault-version" --lock "${W5}/.writeback.lock" --once >/dev/null
rc5=$?; set -e
assert_exit "W-5 Vault unreachable → non-zero exit" 1 "${rc5}"
current_content="$(cat "${W5}/auth.json")"
assert_eq "W-5 local auth.json unchanged on failure" "${ORIG}" "${current_content}"

# ---------------------------------------------------------------------------
# S-1: two concurrent writebacks → at most 2 vault puts (no runaway loop)
# ---------------------------------------------------------------------------
S1="${TMPDIR_BASE}/s1"; mkdir -p "${S1}"
printf '{"access_token":"concurrent"}' > "${S1}/auth.json"
printf '1' > "${S1}/.vault-version"
export VAULT_MOCK_CURRENT_VER=1 VAULT_MOCK_CAS_MATCH_VER=1 VAULT_MOCK_UNREACHABLE=0
build_mock_vault "${S1}/mock-vault"
export VAULT_MOCK_LOG="${S1}/vault.log"
old_path_s1="${PATH}"
export PATH="${S1}/mock-vault:${old_path_s1}"
bash "${WRITEBACK_SCRIPT}" \
    --auth-file "${S1}/auth.json" --vault-path "arcanada/prod/env/codex-cli" \
    --marker "${S1}/.vault-version" --lock "${S1}/.writeback.lock" --once >/dev/null 2>&1 &
PID1=$!
bash "${WRITEBACK_SCRIPT}" \
    --auth-file "${S1}/auth.json" --vault-path "arcanada/prod/env/codex-cli" \
    --marker "${S1}/.vault-version" --lock "${S1}/.writeback.lock" --once >/dev/null 2>&1 &
PID2=$!
wait "${PID1}" 2>/dev/null || true
wait "${PID2}" 2>/dev/null || true
export PATH="${old_path_s1}"; unset VAULT_MOCK_LOG

total_puts="$(grep -c "kv put" "${S1}/vault.log" 2>/dev/null || echo 0)"
if [ "${total_puts}" -le 2 ]; then
    printf 'ok   S-1 concurrent writebacks: %s put(s), no runaway\n' "${total_puts}"
else
    printf 'FAIL S-1 %s puts (expected <=2)\n' "${total_puts}"; fail=1
fi

# ---------------------------------------------------------------------------
# S-2: pre-held lock → second invocation exits 0, no put
# ---------------------------------------------------------------------------
S2="${TMPDIR_BASE}/s2"; mkdir -p "${S2}"
printf '{"access_token":"lock-test"}' > "${S2}/auth.json"
printf '1' > "${S2}/.vault-version"
mkdir -p "${S2}/.writeback.lock"  # pre-hold the lock
export VAULT_MOCK_CURRENT_VER=1 VAULT_MOCK_CAS_MATCH_VER=1 VAULT_MOCK_UNREACHABLE=0

set +e
run_writeback "${S2}" \
    --auth-file "${S2}/auth.json" --vault-path "arcanada/prod/env/codex-cli" \
    --marker "${S2}/.vault-version" --lock "${S2}/.writeback.lock" --once >/dev/null
rc_s2=$?; set -e
assert_exit "S-2 pre-held lock → exit 0 (skip)" 0 "${rc_s2}"
put_s2="$(grep -c "kv put" "${S2}/vault.log" 2>/dev/null || echo 0)"
assert_eq "S-2 no vault put when lock held" "0" "${put_s2}"

# ---------------------------------------------------------------------------
# S-3: static HCL policy check — sidecar policy has create+update capabilities
# ---------------------------------------------------------------------------
RUNBOOK_PATH="${SCRIPT_DIR}/../documentation/infrastructure/vault-secondary-bootstrap/codex-oauth-recovery.md"
if [ -f "${RUNBOOK_PATH}" ]; then
    if grep -qE '"create".*"update"|"update".*"create"' "${RUNBOOK_PATH}" 2>/dev/null; then
        printf 'ok   S-3 HCL draft grants create+update to sidecar role\n'
    else
        printf 'FAIL S-3 runbook missing create+update in HCL draft\n'; fail=1
    fi
else
    printf 'SKIP S-3 runbook not yet written (phase 6)\n'
fi

if [ "${fail}" -eq 0 ]; then printf '\nall tests passed\n'; fi
exit "${fail}"
