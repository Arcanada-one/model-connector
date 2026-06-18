#!/usr/bin/env bash
# Codex CLI sidecar entrypoint — CONN-0045 Phase 1 (CONN-0063)
#
# Resolves OAuth credentials from Vault at container startup and writes them to a
# tmpfs-backed location. The blob never lands on the image filesystem (T1 mitigation).
#
# Required env:
#   VAULT_ADDR              — e.g. https://vault.arcanada.one:8200 (Tailscale-only)
#   VAULT_ROLE_ID           — AppRole role-id (mounted via secret/env)
#   VAULT_SECRET_ID         — AppRole secret-id (rotated, short-lived)
#   VAULT_KV_PATH           — default arcanada/prod/env/codex-cli
#   CODEX_HOME              — default /dev/shm/codex-auth (set in compose overlay; CONN-0068)
#
# Optional env:
#   CODEX_AUTH_STRATEGY     — vault-blob (default) | device-code
#   ALLOW_MISSING_OAUTH     — 1 to skip OAuth fetch (sidecar starts in --help-only mode);
#                             used by V-12 verification (image-layer probe).
#   MC_USER_UID             — UID to chown the materialised blob to (default 1001).
#                             Must match `model-connector` container's runtime user
#                             (Dockerfile creates `connector` via `useradd -m`,
#                             which lands at UID 1001 on node:22-slim because the
#                             base image already occupies UID 1000 with `node`).
#   MC_USER_GID             — GID for the same chown (default 1001).

set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

VAULT_KV_PATH="${VAULT_KV_PATH:-arcanada/prod/env/codex-cli}"
CODEX_AUTH_STRATEGY="${CODEX_AUTH_STRATEGY:-vault-blob}"
ALLOW_MISSING_OAUTH="${ALLOW_MISSING_OAUTH:-0}"
AUTH_TARGET="${CODEX_HOME:-/dev/shm/codex-auth}/auth.json"

# ---------------------------------------------------------------------------
# Sourceable helper: codex_should_materialize
#
# Returns 0 (materialize) or 1 (skip / fail-safe) based on freshness:
#   codex_should_materialize <auth_target> <marker_path> <vault_current_version>
#
# Rules:
#   - auth_target absent          → 0 (materialize: first-boot seed)
#   - marker absent, auth present → 1 (fail-safe: skip, don't clobber fresh token)
#   - marker version == vault ver → 1 (skip: already at current Vault version)
#   - vault ver > marker version  → 0 (materialize: operator re-seeded)
# ---------------------------------------------------------------------------
codex_should_materialize() {
    local auth_target="$1"
    local marker_path="$2"
    local vault_ver="$3"

    # auth.json absent → always materialize
    if [ ! -f "${auth_target}" ]; then
        return 0
    fi

    # auth.json present but marker absent → fail-safe: skip to protect possibly-fresh token
    if [ ! -f "${marker_path}" ]; then
        log "Warning: auth.json present but .vault-version marker absent (upgrade path?). Skipping overwrite (fail-safe)."
        return 1
    fi

    local local_ver
    local_ver="$(cat "${marker_path}" 2>/dev/null)" || local_ver=""

    # No vault version available → fail-safe: skip
    if [ -z "${vault_ver}" ]; then
        log "Warning: Vault version unavailable, skipping overwrite (fail-safe)."
        return 1
    fi

    # Vault newer than local marker → materialize
    if [ "${vault_ver}" -gt "${local_ver:-0}" ] 2>/dev/null; then
        return 0
    fi

    # Same or older → skip (local rotated token is at least as fresh)
    return 1
}

# When sourced by tests, skip all side-effectful startup.
if [ "${CONN_0222_TEST_ONLY:-0}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

# Verification mode bypasses every gate; used by V-12 (image-layer secret probe)
# and by `docker run` smoke checks that never need to touch Vault.
if [ "${ALLOW_MISSING_OAUTH}" = "1" ]; then
    log "ALLOW_MISSING_OAUTH=1 — skipping Vault fetch and tmpfs gate (verification mode)."
    exec "$@"
fi

# Verify tmpfs is actually mounted at CODEX_HOME (T1 fail-closed). CONN-0079:
# previously we ran `mountpoint -q` first, but under sidecar caps
# (`cap_drop=ALL`, `read_only=true`, `security_opt=no-new-privileges`) busybox
# `mountpoint` exits 1 on `..` traversal (EACCES) for valid tmpfs binds. We now
# rely on /proc/self/mountinfo only — kernel-authoritative, readable to the
# calling process, no namespace caveats.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/is_tmpfs_mount.sh
. "${SCRIPT_DIR}/lib/is_tmpfs_mount.sh"
# shellcheck source=lib/vault-kv-version.sh
. "${SCRIPT_DIR}/lib/vault-kv-version.sh"

if ! is_tmpfs_mount "${CODEX_HOME}"; then
    log "FATAL: ${CODEX_HOME} is not tmpfs-backed — refusing to write OAuth blob."
    log "Compose overlay must declare a tmpfs volume or a bind from a host tmpfs"
    log "(e.g. /dev/shm subdirectory) at ${CODEX_HOME}."
    exit 70
fi

if [ "${CODEX_AUTH_STRATEGY}" != "vault-blob" ]; then
    log "CODEX_AUTH_STRATEGY=${CODEX_AUTH_STRATEGY} — entrypoint only handles vault-blob."
    log "device-code flow must be performed manually before container start."
    exec "$@"
fi

# CONN-0080: reclaim ownership of ${CODEX_HOME} BEFORE mktemp. After CONN-0079
# unblocked the materialise step, the prior entrypoint left the dir as
# MC_UID:MC_GID 0700; on any restart root in container under cap_drop=ALL
# cannot create a temp file inside a non-owned 0700 dir without
# CAP_DAC_OVERRIDE — `mktemp: Permission denied` → restart loop. CAP_CHOWN
# bypasses the owner check, so we can reclaim regardless of current owner.
# chown FIRST (works on any owner), chmod SECOND (we now own → no CAP_FOWNER
# needed). End-state: root:MC_GID 0770 — sidecar (root) writes via mktemp
# while MC (group MC_GID) traverses AND writes via group rwx. CONN-0217:
# codex CLI ≥ 0.130 spawns an in-process app-server that creates state files
# inside ${CODEX_HOME} from the MC user (uid 1001); without group `w` it
# fails with "failed to initialize in-process app-server client: Permission
# denied (os error 13)". Auth confidentiality is preserved by file perms
# (auth.json stays 0600 owned by MC user — only that uid can read it).
# Idempotent on re-runs.
MC_USER_UID="${MC_USER_UID:-1001}"
MC_USER_GID="${MC_USER_GID:-1001}"
if ! chown "0:${MC_USER_GID}" "${CODEX_HOME}"; then
    log "FATAL: chown ${CODEX_HOME} to 0:${MC_USER_GID} failed — likely missing CAP_CHOWN."
    log "Ensure 'cap_add: [CHOWN]' is set on codex-sidecar service in docker-compose.codex.yml."
    exit 73
fi
chmod 0770 "${CODEX_HOME}"

: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_ROLE_ID:?VAULT_ROLE_ID is required}"
: "${VAULT_SECRET_ID:?VAULT_SECRET_ID is required}"

log "AppRole login at ${VAULT_ADDR} (role-id redacted)"
# 30s timeout guards against unreachable Vault hanging container startup.
VAULT_TOKEN="$(timeout 30 vault write -field=token auth/approle/login \
    role_id="${VAULT_ROLE_ID}" secret_id="${VAULT_SECRET_ID}")"
export VAULT_TOKEN
unset VAULT_ROLE_ID VAULT_SECRET_ID

# Fetch Vault KV-v2 current version for freshness comparison (CONN-0222).
VAULT_VERSION_MARKER="${CODEX_HOME}/.vault-version"
VAULT_CURRENT_VER="$(vault_kv_current_version "${VAULT_KV_PATH}")" || VAULT_CURRENT_VER=""

if codex_should_materialize "${AUTH_TARGET}" "${VAULT_VERSION_MARKER}" "${VAULT_CURRENT_VER}"; then
    log "Fetching ${VAULT_KV_PATH}.oauth_credentials (Vault ver=${VAULT_CURRENT_VER:-unknown})"
    OAUTH_BLOB="$(timeout 30 vault kv get -field=oauth_credentials "${VAULT_KV_PATH}")"

    if [ -z "${OAUTH_BLOB}" ]; then
        log "FATAL: Vault returned empty oauth_credentials. Check operator provisioning."
        exit 71
    fi

    # Write atomically with strict permissions; never echo the blob.
    umask 0177
    TMPFILE="$(mktemp "${CODEX_HOME}/.auth.XXXXXX")"
    printf '%s' "${OAUTH_BLOB}" > "${TMPFILE}"
    chmod 0600 "${TMPFILE}"
    mv -f "${TMPFILE}" "${AUTH_TARGET}"
    unset OAUTH_BLOB
    unset VAULT_TOKEN

    # Update the .vault-version marker so next restart knows which version is local.
    if [ -n "${VAULT_CURRENT_VER}" ]; then
        printf '%s' "${VAULT_CURRENT_VER}" > "${VAULT_VERSION_MARKER}"
    fi

    log "OAuth blob materialised at ${AUTH_TARGET} (mode 600, tmpfs, vault-ver=${VAULT_CURRENT_VER:-unknown})"
else
    log "Skipping Vault re-seed: local auth.json is current (vault-ver=${VAULT_CURRENT_VER:-unknown}, marker=$(cat "${VAULT_VERSION_MARKER}" 2>/dev/null || echo none))."
    unset VAULT_TOKEN
fi

# CONN-0068 + CONN-0080 + CONN-0217: AUTH_TARGET inherits root ownership via
# mktemp+mv. Hand off the FILE to MC user so MC's spawned `codex` (running
# as `connector`, UID 1001 on node:22-slim) can read it across the bind
# mount. Directory ownership is left at root:MC_GID 0770 (set early, see
# top-of-script comment) — MC traverses AND writes via the group bits
# (required by codex CLI ≥ 0.130 in-process app-server), sidecar (root)
# keeps owner-write across restarts. T-NEW preserved: auth.json stays mode
# 0600 owned by MC user; only that UID can read content. Requires CAP_CHOWN
# (`cap_add: [CHOWN]`).
if [ -f "${AUTH_TARGET}" ]; then
    if ! chown "${MC_USER_UID}:${MC_USER_GID}" "${AUTH_TARGET}"; then
        log "FATAL: chown ${AUTH_TARGET} to ${MC_USER_UID}:${MC_USER_GID} failed — likely missing CAP_CHOWN."
        exit 73
    fi
    log "Set ${CODEX_HOME}=root:${MC_USER_GID} 0770, ${AUTH_TARGET}=${MC_USER_UID}:${MC_USER_GID} 0600 (CONN-0217)."
fi

# Quick smoke — codex --version exercises auth.json parse path without spending tokens.
if ! codex --version >/dev/null 2>&1; then
    log "FATAL: codex --version failed after auth materialisation."
    exit 72
fi

log "Sidecar ready — codex $(codex --version 2>&1)"
exec "$@"
