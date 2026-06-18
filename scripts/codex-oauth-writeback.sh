#!/usr/bin/env bash
# codex-oauth-writeback.sh — mtime-watch writeback of auth.json to Vault KV-v2.
#
# Launched by the codex-sidecar-entrypoint.sh (backgrounded after smoke check)
# to write rotated OAuth tokens back to Vault so the next sidecar restart
# materialises the current (not stale) token. (CONN-0222 Phases 2+3)
#
# Usage:
#   codex-oauth-writeback.sh [options]
#
# Options:
#   --auth-file <path>     auth.json to watch (default: ${CODEX_HOME}/auth.json)
#   --vault-path <path>    Vault KV-v2 path (default: ${VAULT_KV_PATH:-arcanada/prod/env/codex-cli})
#   --marker <path>        .vault-version marker (default: ${CODEX_HOME}/.vault-version)
#   --lock <path>          advisory lock dir path (default: ${CODEX_HOME}/.writeback.lock)
#   --once                 run a single writeback and exit (for tests / debugging)
#   --poll-interval <n>    mtime-poll interval seconds (default: 5)
#
# Required env (unless --auth-file/--vault-path override):
#   VAULT_ADDR, VAULT_TOKEN (already exported by entrypoint before backgrounding)
#   VAULT_KV_PATH
#   CODEX_HOME
#
# Single-flight design (D2):
#   - Only the sidecar watch-loop calls this script; MC has no writeback AppRole.
#   - Advisory mkdir-lock (${CODEX_HOME}/.writeback.lock) prevents two iterations
#     within one sidecar from racing before Vault CAS fires.
#   - Vault KV-v2 CAS (--cas=<current_version>) is the cross-process safety-net
#     for the residual race (two sidecar instances during rolling deploy / overlap).
#   - CAS conflict → re-read the now-newer Vault blob, re-materialize locally;
#     do NOT loop-retry the write (would overwrite the winner's freshly rotated token).

set -euo pipefail

log() { printf '[writeback] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
AUTH_FILE=""
VAULT_PATH="${VAULT_KV_PATH:-arcanada/prod/env/codex-cli}"
MARKER_FILE=""
LOCK_DIR=""
ONCE=0
POLL_INTERVAL=5

while [ $# -gt 0 ]; do
    case "$1" in
        --auth-file)      AUTH_FILE="$2";    shift 2 ;;
        --vault-path)     VAULT_PATH="$2";   shift 2 ;;
        --marker)         MARKER_FILE="$2";  shift 2 ;;
        --lock)           LOCK_DIR="$2";     shift 2 ;;
        --once)           ONCE=1;            shift   ;;
        --poll-interval)  POLL_INTERVAL="$2";shift 2 ;;
        *) log "Unknown option: $1"; exit 1 ;;
    esac
done

CODEX_HOME_DEFAULT="${CODEX_HOME:-/dev/shm/codex-auth}"
AUTH_FILE="${AUTH_FILE:-${CODEX_HOME_DEFAULT}/auth.json}"
MARKER_FILE="${MARKER_FILE:-${CODEX_HOME_DEFAULT}/.vault-version}"
LOCK_DIR="${LOCK_DIR:-${CODEX_HOME_DEFAULT}/.writeback.lock}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/vault-kv-version.sh
. "${SCRIPT_DIR}/lib/vault-kv-version.sh"

# ---------------------------------------------------------------------------
# do_writeback: single writeback attempt with CAS + single-flight lock.
#   Returns 0 on success (CAS write or CAS conflict re-read).
#   Returns 1 on hard failure (Vault unreachable, write error).
# ---------------------------------------------------------------------------
do_writeback() {
    # Acquire advisory lock (mkdir is atomic on POSIX filesystems + tmpfs).
    if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
        log "Lock held by another iteration — skipping this cycle."
        return 0
    fi
    # Ensure lock is released even if we error out.
    trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' RETURN

    # Read current Vault version for CAS parameter.
    local vault_ver
    vault_ver="$(vault_kv_current_version "${VAULT_PATH}")" || vault_ver=""

    if [ -z "${vault_ver}" ]; then
        log "Warning: cannot read Vault metadata version — skipping writeback this cycle."
        return 0
    fi

    # Read current auth.json content.
    local blob
    blob="$(cat "${AUTH_FILE}" 2>/dev/null)" || { log "Cannot read ${AUTH_FILE}"; return 0; }

    if [ -z "${blob}" ]; then
        log "auth.json is empty — skipping writeback."
        return 0
    fi

    log "Writing auth.json to Vault (path=${VAULT_PATH} cas=${vault_ver})"

    # CAS write: fails if Vault version already advanced (another writer won).
    local put_out
    local put_rc=0
    put_out="$(printf '%s' "${blob}" | \
        vault kv put "-cas=${vault_ver}" "${VAULT_PATH}" "oauth_credentials=-" 2>&1)" || put_rc=$?

    if [ "${put_rc}" -eq 0 ]; then
        # Success — update local marker.
        printf '%s' "${vault_ver}" > "${MARKER_FILE}"
        log "Writeback succeeded (vault-ver=${vault_ver})."
        return 0
    fi

    # Check if this is a CAS conflict (expected race — another writer won).
    if printf '%s' "${put_out}" | grep -q "check-and-set parameter did not match"; then
        log "CAS conflict: another writer advanced Vault version. Re-reading fresh blob."
        # Re-read Vault blob and re-materialize locally (so local == authoritative).
        local fresh_blob
        fresh_blob="$(vault kv get -field=oauth_credentials "${VAULT_PATH}" 2>/dev/null)" || {
            log "Warning: CAS conflict but cannot re-read Vault blob — keeping local token."
            return 0
        }
        if [ -n "${fresh_blob}" ]; then
            umask 0177
            local tmpf
            tmpf="$(mktemp "$(dirname "${AUTH_FILE}")/.auth.XXXXXX")"
            printf '%s' "${fresh_blob}" > "${tmpf}"
            chmod 0600 "${tmpf}"
            mv -f "${tmpf}" "${AUTH_FILE}"
            # Update marker to reflect the now-current Vault version.
            local new_ver
            new_ver="$(vault_kv_current_version "${VAULT_PATH}")" || new_ver="${vault_ver}"
            printf '%s' "${new_ver}" > "${MARKER_FILE}"
            log "Re-materialized from Vault after CAS conflict (vault-ver=${new_ver})."
        fi
        return 0
    fi

    # Other failure (Vault unreachable, policy error, etc.) — fail-closed.
    log "ERROR: Vault writeback failed (rc=${put_rc}): ${put_out}"
    return 1
}

# ---------------------------------------------------------------------------
# Watch loop
# ---------------------------------------------------------------------------
LAST_MTIME=""

get_mtime() {
    # Portable mtime: GNU stat -c '%Y' first, BSD stat -f '%m' fallback.
    stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1" 2>/dev/null || echo ""
}

if [ "${ONCE}" = "1" ]; then
    # Single-shot mode (used by tests and entrypoint post-smoke launch).
    if [ ! -f "${AUTH_FILE}" ]; then
        log "auth.json not found at ${AUTH_FILE} — nothing to write back."
        exit 0
    fi
    do_writeback
    exit $?
fi

log "Starting mtime-watch loop (auth=${AUTH_FILE}, interval=${POLL_INTERVAL}s)"
LAST_MTIME="$(get_mtime "${AUTH_FILE}")"

while true; do
    sleep "${POLL_INTERVAL}"
    if [ ! -f "${AUTH_FILE}" ]; then
        continue
    fi
    CURRENT_MTIME="$(get_mtime "${AUTH_FILE}")"
    if [ "${CURRENT_MTIME}" != "${LAST_MTIME}" ]; then
        log "mtime changed (${LAST_MTIME} → ${CURRENT_MTIME}) — triggering writeback."
        LAST_MTIME="${CURRENT_MTIME}"
        do_writeback || log "Writeback failed; local token retained."
    fi
done
