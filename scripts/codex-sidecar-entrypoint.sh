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
#   CODEX_HOME              — default /tmpfs/codex-auth (set in Dockerfile)
#
# Optional env:
#   CODEX_AUTH_STRATEGY     — vault-blob (default) | device-code
#   ALLOW_MISSING_OAUTH     — 1 to skip OAuth fetch (sidecar starts in --help-only mode);
#                             used by V-12 verification (image-layer probe).

set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

VAULT_KV_PATH="${VAULT_KV_PATH:-arcanada/prod/env/codex-cli}"
CODEX_AUTH_STRATEGY="${CODEX_AUTH_STRATEGY:-vault-blob}"
ALLOW_MISSING_OAUTH="${ALLOW_MISSING_OAUTH:-0}"
AUTH_TARGET="${CODEX_HOME}/auth.json"

# Verification mode bypasses every gate; used by V-12 (image-layer secret probe)
# and by `docker run` smoke checks that never need to touch Vault.
if [ "${ALLOW_MISSING_OAUTH}" = "1" ]; then
    log "ALLOW_MISSING_OAUTH=1 — skipping Vault fetch and tmpfs gate (verification mode)."
    exec "$@"
fi

# Verify tmpfs is actually mounted at CODEX_HOME (T1 fail-closed). busybox does
# bundle `mountpoint`; the /proc/self/mountinfo fallback covers cases where it
# might be stripped from a future minimal base image. `stat -c %m` is GNU-only
# and returns the literal "m" on busybox, so it is unsafe as a fallback.
is_tmpfs_mount() {
    local target="$1"
    if command -v mountpoint >/dev/null 2>&1; then
        mountpoint -q "${target}" || return 1
    elif [ -r /proc/self/mountinfo ]; then
        awk -v t="${target}" '$5 == t { found = 1 } END { exit !found }' \
            /proc/self/mountinfo || return 1
    else
        return 1
    fi
    awk -v t="${target}" '$5 == t && $9 == "tmpfs" { found = 1 } END { exit !found }' \
        /proc/self/mountinfo
}

if ! is_tmpfs_mount "${CODEX_HOME}"; then
    log "FATAL: ${CODEX_HOME} is not a tmpfs mount — refusing to write OAuth blob."
    log "Compose overlay must declare a tmpfs volume at ${CODEX_HOME}."
    exit 70
fi

if [ "${CODEX_AUTH_STRATEGY}" != "vault-blob" ]; then
    log "CODEX_AUTH_STRATEGY=${CODEX_AUTH_STRATEGY} — entrypoint only handles vault-blob."
    log "device-code flow must be performed manually before container start."
    exec "$@"
fi

: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_ROLE_ID:?VAULT_ROLE_ID is required}"
: "${VAULT_SECRET_ID:?VAULT_SECRET_ID is required}"

log "AppRole login at ${VAULT_ADDR} (role-id redacted)"
# 30s timeout guards against unreachable Vault hanging container startup.
VAULT_TOKEN="$(timeout 30 vault write -field=token auth/approle/login \
    role_id="${VAULT_ROLE_ID}" secret_id="${VAULT_SECRET_ID}")"
export VAULT_TOKEN
unset VAULT_ROLE_ID VAULT_SECRET_ID

log "Fetching ${VAULT_KV_PATH}.oauth_credentials"
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

log "OAuth blob materialised at ${AUTH_TARGET} (mode 600, tmpfs)"

# Quick smoke — codex --version exercises auth.json parse path without spending tokens.
if ! codex --version >/dev/null 2>&1; then
    log "FATAL: codex --version failed after auth materialisation."
    exit 72
fi

log "Sidecar ready — codex $(codex --version 2>&1)"
exec "$@"
