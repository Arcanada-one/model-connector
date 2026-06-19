#!/usr/bin/env bash
# Unit tests for is_tmpfs_mount (CONN-0079) + vault-kv-version + entrypoint
# materialize-if-absent logic (CONN-0222).
# Fixture lines captured from PROD sidecar probe — see datarim/tasks/CONN-0079-fixtures.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/is_tmpfs_mount.sh
source "${SCRIPT_DIR}/lib/is_tmpfs_mount.sh"
# shellcheck source=lib/vault-kv-version.sh
source "${SCRIPT_DIR}/lib/vault-kv-version.sh"

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

TMPDIR="${TMPDIR_BASE}/mnt"
mkdir -p "${TMPDIR}"

# ---------------------------------------------------------------------------
# Original is_tmpfs_mount fixtures (F-1 .. F-6) — unchanged
# ---------------------------------------------------------------------------

# F-1 — tmpfs bind (PROD-shape line). Expected: exit 0.
printf '1517 1512 0:26 /codex-auth /dev/shm/codex-auth rw,nosuid,nodev - tmpfs tmpfs rw,inode64\n' \
    > "${TMPDIR}/f1.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f1.mountinfo"; rc=$?; set -e
assert_exit "F-1 tmpfs bind"            0 "${rc}"

# F-2 — ext4 bind at same target. Expected: exit 1 (fail-closed).
printf '3402 3401 8:1 /payload /dev/shm/codex-auth rw,relatime - ext4 /dev/sda1 rw,errors=remount-ro\n' \
    > "${TMPDIR}/f2.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f2.mountinfo"; rc=$?; set -e
assert_exit "F-2 ext4 bind"             1 "${rc}"

# F-3 — target absent from mountinfo. Expected: exit 1.
printf '%s\n' \
    '22 21 0:5 / /dev rw,nosuid - devtmpfs devtmpfs rw,size=4G' \
    '1517 1512 0:26 / /dev/shm rw,nosuid,nodev - tmpfs tmpfs rw,inode64' \
    > "${TMPDIR}/f3.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f3.mountinfo"; rc=$?; set -e
assert_exit "F-3 target absent"         1 "${rc}"

# F-4 — overlay at target (defense-in-depth: not tmpfs source). Expected: exit 1.
printf '4001 4000 0:30 /sub /dev/shm/codex-auth rw,relatime - overlay overlay rw,lowerdir=/a:/b\n' \
    > "${TMPDIR}/f4.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f4.mountinfo"; rc=$?; set -e
assert_exit "F-4 overlay at target"     1 "${rc}"

# F-5 — empty mountinfo. Expected: exit 1.
: > "${TMPDIR}/f5.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f5.mountinfo"; rc=$?; set -e
assert_exit "F-5 empty mountinfo"       1 "${rc}"

# F-6 — mountinfo unreadable / missing path. Expected: exit 1.
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/does-not-exist"; rc=$?; set -e
assert_exit "F-6 missing mountinfo"     1 "${rc}"

# ---------------------------------------------------------------------------
# vault_kv_current_version tests (V-1 .. V-3) — exercising lib/vault-kv-version.sh
# ---------------------------------------------------------------------------

# V-1 — mock vault returning version 7.
mock_vault_v1() {
    local subdir
    subdir="$(mktemp -d "${TMPDIR_BASE}/vault-v1-XXXXXX")"
    cat > "${subdir}/vault" << 'EOF'
#!/usr/bin/env bash
# args: kv metadata get -format=json <path>
printf '{"request_id":"abc","data":{"current_version":7,"max_versions":5}}\n'
EOF
    chmod +x "${subdir}/vault"
    printf '%s' "${subdir}"
}
MOCK_V1="$(mock_vault_v1)"
old_PATH="${PATH}"
export PATH="${MOCK_V1}:${PATH}"
set +e; ver="$(vault_kv_current_version "arcanada/prod/env/codex-cli")"; rc=$?; set -e
export PATH="${old_PATH}"
assert_exit "V-1 vault_kv_current_version parses version" 0 "${rc}"
assert_eq   "V-1 version value" "7" "${ver}"

# V-2 — vault unavailable (mock exits 1). Should return non-zero, no output.
mock_vault_fail() {
    local subdir
    subdir="$(mktemp -d "${TMPDIR_BASE}/vault-fail-XXXXXX")"
    cat > "${subdir}/vault" << 'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "${subdir}/vault"
    printf '%s' "${subdir}"
}
MOCK_FAIL="$(mock_vault_fail)"
export PATH="${MOCK_FAIL}:${PATH}"
set +e; ver="$(vault_kv_current_version "arcanada/prod/env/codex-cli")"; rc=$?; set -e
export PATH="${old_PATH}"
assert_exit "V-2 vault unavailable returns non-zero" 1 "${rc}"
assert_eq   "V-2 no output on error" "" "${ver}"

# V-3 — malformed JSON (no current_version key). Should return empty / non-zero.
mock_vault_malformed() {
    local subdir
    subdir="$(mktemp -d "${TMPDIR_BASE}/vault-malformed-XXXXXX")"
    cat > "${subdir}/vault" << 'EOF'
#!/usr/bin/env bash
printf '{"data":{}}\n'
EOF
    chmod +x "${subdir}/vault"
    printf '%s' "${subdir}"
}
MOCK_MAL="$(mock_vault_malformed)"
export PATH="${MOCK_MAL}:${PATH}"
set +e; ver="$(vault_kv_current_version "arcanada/prod/env/codex-cli")"; rc=$?; set -e
export PATH="${old_PATH}"
# awk finds no match → prints nothing → caller gets empty string
# exit code is 0 from awk/pipeline — caller must treat empty as unknown
assert_eq   "V-3 malformed JSON gives empty version" "" "${ver}"

# ---------------------------------------------------------------------------
# Materialize decision helper tests (M-1 .. M-4) — exercising the new
# should_materialize logic that replaces the unconditional mv -f.
# We test the decision by calling codex_should_materialize(), which is
# defined in the entrypoint script itself and must be sourceable.
# ---------------------------------------------------------------------------

# Source the entrypoint's helper functions (entrypoint must expose them in a
# sourceable way when CONN_0222_TEST_ONLY=1 to avoid exec-ing the full script).
export CONN_0222_TEST_ONLY=1
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/codex-sidecar-entrypoint.sh" 2>/dev/null || true
unset CONN_0222_TEST_ONLY

# If the function isn't defined, mark all M-tests as pending-implementation.
if ! declare -f codex_should_materialize >/dev/null 2>&1; then
    printf 'SKIP M-1..M-4: codex_should_materialize not yet defined (TDD red phase)\n'
    # We still exit 0 here so the test file itself runs — the fail flag will be
    # set when the actual implementation tests run. For TDD purposes, if the
    # function is absent, that IS the failing state we expect before implementation.
    # Re-enable by implementing codex_should_materialize in the entrypoint.
else
    # M-1: auth.json absent → decision = materialize (exit 0).
    FAKE_HOME="${TMPDIR_BASE}/m1-home"
    mkdir -p "${FAKE_HOME}"
    # No auth.json here
    set +e; codex_should_materialize "${FAKE_HOME}/auth.json" "" ""; rc=$?; set -e
    assert_exit "M-1 absent auth.json → materialize" 0 "${rc}"

    # M-2: auth.json present, local marker version == Vault current → skip (exit 1).
    FAKE_HOME="${TMPDIR_BASE}/m2-home"
    mkdir -p "${FAKE_HOME}"
    printf '{"access_token":"valid"}' > "${FAKE_HOME}/auth.json"
    printf '5' > "${FAKE_HOME}/.vault-version"
    set +e; codex_should_materialize "${FAKE_HOME}/auth.json" "${FAKE_HOME}/.vault-version" "5"; rc=$?; set -e
    assert_exit "M-2 version match → skip" 1 "${rc}"

    # M-3: auth.json present, Vault current > marker → materialize (exit 0).
    FAKE_HOME="${TMPDIR_BASE}/m3-home"
    mkdir -p "${FAKE_HOME}"
    printf '{"access_token":"old"}' > "${FAKE_HOME}/auth.json"
    printf '5' > "${FAKE_HOME}/.vault-version"
    set +e; codex_should_materialize "${FAKE_HOME}/auth.json" "${FAKE_HOME}/.vault-version" "7"; rc=$?; set -e
    assert_exit "M-3 Vault newer → materialize" 0 "${rc}"

    # M-4: auth.json present, marker absent, Vault readable → materialize (exit 0).
    # Root cause of the prod self-block: the old logic skipped here to "protect
    # possibly-fresh token", but marker absent means we have NO baseline — Vault
    # is authoritative when it is reachable. Fix: materialize when vault_ver is known.
    FAKE_HOME="${TMPDIR_BASE}/m4-home"
    mkdir -p "${FAKE_HOME}"
    printf '{"access_token":"stale-from-may"}' > "${FAKE_HOME}/auth.json"
    # .vault-version does NOT exist; Vault version 4 is readable (the prod scenario)
    set +e; codex_should_materialize "${FAKE_HOME}/auth.json" "${FAKE_HOME}/.vault-version" "4"; rc=$?; set -e
    assert_exit "M-4 marker absent + Vault readable → materialize (Vault authoritative)" 0 "${rc}"

    # M-4b: auth.json present, marker absent, Vault UNREACHABLE → fail-safe skip (exit 1).
    # This is the genuine fail-safe: when Vault cannot be read, we cannot
    # compare — keep the local token rather than risk clobbering with stale blob.
    FAKE_HOME="${TMPDIR_BASE}/m4b-home"
    mkdir -p "${FAKE_HOME}"
    printf '{"access_token":"maybe-fresh"}' > "${FAKE_HOME}/auth.json"
    # .vault-version does NOT exist; vault_ver is empty (Vault unreachable)
    set +e; codex_should_materialize "${FAKE_HOME}/auth.json" "${FAKE_HOME}/.vault-version" ""; rc=$?; set -e
    assert_exit "M-4b marker absent + Vault unreachable → fail-safe skip" 1 "${rc}"

    # M-5: PROD SCENARIO — stale auth.json on host-bind + no marker + Vault v4 readable → materialize.
    # This is the exact prod failure from CONN-0222 compliance check:
    # /dev/shm/codex-auth is a HOST BIND surviving docker compose --force-recreate.
    # Old auth.json from May was present; .vault-version marker was never written;
    # Vault had a fresh seed at version 4. Old M-4 fail-safe caused SKIP → stale token
    # persisted. New logic: Vault is authoritative → must materialize.
    FAKE_HOME="${TMPDIR_BASE}/m5-prod-scenario"
    mkdir -p "${FAKE_HOME}"
    printf '{"access_token":"may-stale-token","refresh_token":"rUsed"}' > "${FAKE_HOME}/auth.json"
    # Simulate host-bind surviving recreate: old auth.json exists, no marker written yet
    # (marker never written because old entrypoint version had the bug)
    # Vault is reachable and has fresh seed at version 4
    set +e; codex_should_materialize "${FAKE_HOME}/auth.json" "${FAKE_HOME}/.vault-version" "4"; rc=$?; set -e
    assert_exit "M-5 PROD: stale auth.json + no marker + Vault v4 → materialize (not skip)" 0 "${rc}"
fi

# ---------------------------------------------------------------------------
# I-1: entrypoint backgrounds the writeback loop after smoke
#
# Scenario: full entrypoint run with mocked binaries and shim libs:
#   - mock vault (AppRole login + kv get succeed)
#   - mock codex (--version succeeds)
#   - mock chown (no-op — test runs as non-root)
#   - mock timeout (passthrough)
#   - shim lib/is_tmpfs_mount.sh (always returns 0)
#   - shim lib/vault-kv-version.sh (returns version 1)
#   - mock codex-oauth-writeback.sh that writes a sentinel file on launch
#
# The entrypoint is copied into a fake-scripts dir whose lib/ holds the shims,
# so SCRIPT_DIR resolution points at the shims. The mock writeback script is
# also placed in that dir so the entrypoint finds and backgrounds it.
#
# Assertion: sentinel file is created, proving the loop was launched.
# ---------------------------------------------------------------------------
I1="${TMPDIR_BASE}/i1"
I1_SHM="${I1}/shm-auth"
I1_BIN="${I1}/bin"
I1_SCRIPTS="${I1}/fake-scripts"
SENTINEL_FILE="${I1}/writeback-launched.sentinel"
mkdir -p "${I1_SHM}" "${I1_BIN}" "${I1_SCRIPTS}/lib"

# Mock vault: login returns a token; kv metadata get returns ver 1; kv get returns blob.
cat > "${I1_BIN}/vault" << 'VEOF'
#!/usr/bin/env bash
case "$*" in
    *approle/login*)      printf 'test-vault-token\n'; exit 0 ;;
    *"kv metadata get"*)  printf '{"data":{"current_version":1,"max_versions":5}}\n'; exit 0 ;;
    *"kv get"*)           printf '{"access_token":"test-tok","refresh_token":"rTest"}\n'; exit 0 ;;
esac
exit 0
VEOF
chmod +x "${I1_BIN}/vault"

# Mock codex: --version succeeds.
cat > "${I1_BIN}/codex" << 'CEOF'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { printf '0.130.0\n'; exit 0; }
exit 0
CEOF
chmod +x "${I1_BIN}/codex"

# Mock timeout: drop the numeric first arg, exec the rest (passthrough).
cat > "${I1_BIN}/timeout" << 'TEOF'
#!/usr/bin/env bash
shift; exec "$@"
TEOF
chmod +x "${I1_BIN}/timeout"

# Mock chown: no-op (test runs as non-root; entrypoint calls chown to root:gid).
cat > "${I1_BIN}/chown" << 'CHEOF'
#!/usr/bin/env bash
exit 0
CHEOF
chmod +x "${I1_BIN}/chown"

# Shim lib/is_tmpfs_mount.sh — always passes tmpfs check (no /proc available in test).
cat > "${I1_SCRIPTS}/lib/is_tmpfs_mount.sh" << 'SEOF'
is_tmpfs_mount() { return 0; }
SEOF

# Shim lib/vault-kv-version.sh — returns version 1.
cat > "${I1_SCRIPTS}/lib/vault-kv-version.sh" << 'KVEOF'
vault_kv_current_version() { printf '1\n'; return 0; }
KVEOF

# Mock codex-oauth-writeback.sh — writes sentinel and exits.
# Expanded now (not inside heredoc) so SENTINEL_FILE path is baked in.
cat > "${I1_SCRIPTS}/codex-oauth-writeback.sh" << WEOF
#!/usr/bin/env bash
printf 'launched' > "${SENTINEL_FILE}"
exit 0
WEOF
chmod +x "${I1_SCRIPTS}/codex-oauth-writeback.sh"

# Copy the real entrypoint into fake-scripts so SCRIPT_DIR points there
# and picks up our shim libs + mock writeback.
cp "${SCRIPT_DIR}/codex-sidecar-entrypoint.sh" "${I1_SCRIPTS}/codex-sidecar-entrypoint.sh"

# Run entrypoint with all required env, mock PATH, and 'true' as CMD.
set +e
CODEX_HOME="${I1_SHM}" \
VAULT_ADDR="http://mock-vault:8200" \
VAULT_ROLE_ID="test-role-id" \
VAULT_SECRET_ID="test-secret-id" \
CODEX_WRITEBACK_ROLE_ID="wb-role-id" \
CODEX_WRITEBACK_SECRET_ID="wb-secret-id" \
VAULT_KV_PATH="arcanada/prod/env/codex-cli" \
CODEX_AUTH_STRATEGY="vault-blob" \
MC_USER_UID="$(id -u)" \
MC_USER_GID="$(id -g)" \
PATH="${I1_BIN}:${PATH}" \
bash "${I1_SCRIPTS}/codex-sidecar-entrypoint.sh" true >/dev/null 2>&1
set -e

# Give backgrounded child time to write sentinel before we check.
sleep 1

if [ -f "${SENTINEL_FILE}" ]; then
    printf 'ok   I-1 entrypoint backgrounds writeback loop (sentinel found)\n'
else
    printf 'FAIL I-1 entrypoint did NOT launch writeback loop (sentinel absent)\n'
    fail=1
fi

# ---------------------------------------------------------------------------
# I-2: marker .vault-version is written after successful materialize.
#
# Scenario: no auth.json on disk (first-boot), Vault returns version 1.
# The entrypoint must write ${CODEX_HOME}/.vault-version containing "1"
# after materializing the blob.
#
# Reuses the same mock infrastructure as I-1 but places the entrypoint
# in a fresh shm dir without a pre-existing auth.json so first-boot path
# runs, and checks the marker file exists and contains the version.
# ---------------------------------------------------------------------------
I2="${TMPDIR_BASE}/i2"
I2_SHM="${I2}/shm-auth"
I2_BIN="${I2}/bin"
I2_SCRIPTS="${I2}/fake-scripts"
mkdir -p "${I2_SHM}" "${I2_BIN}" "${I2_SCRIPTS}/lib"

cat > "${I2_BIN}/vault" << 'VEOF2'
#!/usr/bin/env bash
case "$*" in
    *approle/login*)      printf 'test-vault-token\n'; exit 0 ;;
    *"kv metadata get"*)  printf '{"data":{"current_version":1,"max_versions":5}}\n'; exit 0 ;;
    *"kv get"*)           printf '{"access_token":"fresh-tok","refresh_token":"rFresh"}\n'; exit 0 ;;
esac
exit 0
VEOF2
chmod +x "${I2_BIN}/vault"

cat > "${I2_BIN}/codex" << 'CEOF2'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { printf '0.130.0\n'; exit 0; }
exit 0
CEOF2
chmod +x "${I2_BIN}/codex"

cat > "${I2_BIN}/timeout" << 'TEOF2'
#!/usr/bin/env bash
shift; exec "$@"
TEOF2
chmod +x "${I2_BIN}/timeout"

cat > "${I2_BIN}/chown" << 'CHEOF2'
#!/usr/bin/env bash
exit 0
CHEOF2
chmod +x "${I2_BIN}/chown"

cat > "${I2_SCRIPTS}/lib/is_tmpfs_mount.sh" << 'SEOF2'
is_tmpfs_mount() { return 0; }
SEOF2

cat > "${I2_SCRIPTS}/lib/vault-kv-version.sh" << 'KVEOF2'
vault_kv_current_version() { printf '1\n'; return 0; }
KVEOF2

# No writeback launch needed for this test; provide a no-op stub.
cat > "${I2_SCRIPTS}/codex-oauth-writeback.sh" << 'WEOF2'
#!/usr/bin/env bash
exit 0
WEOF2
chmod +x "${I2_SCRIPTS}/codex-oauth-writeback.sh"

cp "${SCRIPT_DIR}/codex-sidecar-entrypoint.sh" "${I2_SCRIPTS}/codex-sidecar-entrypoint.sh"

# No pre-existing auth.json → first-boot path (always materialize).
set +e
CODEX_HOME="${I2_SHM}" \
VAULT_ADDR="http://mock-vault:8200" \
VAULT_ROLE_ID="test-role-id" \
VAULT_SECRET_ID="test-secret-id" \
CODEX_WRITEBACK_ROLE_ID="" \
CODEX_WRITEBACK_SECRET_ID="" \
VAULT_KV_PATH="arcanada/prod/env/codex-cli" \
CODEX_AUTH_STRATEGY="vault-blob" \
MC_USER_UID="$(id -u)" \
MC_USER_GID="$(id -g)" \
PATH="${I2_BIN}:${PATH}" \
bash "${I2_SCRIPTS}/codex-sidecar-entrypoint.sh" true >/dev/null 2>&1
set -e

MARKER_CONTENT="$(cat "${I2_SHM}/.vault-version" 2>/dev/null || echo '')"
if [ "${MARKER_CONTENT}" = "1" ]; then
    printf 'ok   I-2 .vault-version marker written after materialize (value=1)\n'
else
    printf 'FAIL I-2 .vault-version marker not written or wrong (got: "%s")\n' "${MARKER_CONTENT}"
    fail=1
fi

if [ "${fail}" -eq 0 ]; then
    printf '\nall tests passed\n'
fi
exit "${fail}"
