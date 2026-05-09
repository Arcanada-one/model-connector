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

# Verify tmpfs is actually mounted at CODEX_HOME (T1 fail-closed).
if ! mountpoint -q "${CODEX_HOME}" 2>/dev/null; then
    # mountpoint is not in busybox; fallback heuristic — refuse if writable + on rootfs.
    if [ "$(stat -c '%m' "${CODEX_HOME}" 2>/dev/null || echo /)" = "/" ]; then
        log "FATAL: ${CODEX_HOME} is not on a tmpfs mount — refusing to write OAuth blob."
        log "Compose overlay must declare:  tmpfs: [/tmpfs/codex-auth]"
        exit 70
    fi
fi

if [ "${ALLOW_MISSING_OAUTH}" = "1" ]; then
    log "ALLOW_MISSING_OAUTH=1 — skipping Vault fetch (verification mode)."
    exec "$@"
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
VAULT_TOKEN="$(vault write -field=token auth/approle/login \
    role_id="${VAULT_ROLE_ID}" secret_id="${VAULT_SECRET_ID}")"
export VAULT_TOKEN
unset VAULT_ROLE_ID VAULT_SECRET_ID

log "Fetching ${VAULT_KV_PATH}.oauth_credentials"
OAUTH_BLOB="$(vault kv get -field=oauth_credentials "${VAULT_KV_PATH}")"

if [ -z "${OAUTH_BLOB}" ]; then
    log "FATAL: Vault returned empty oauth_credentials. Check operator provisioning."
    exit 71
fi

# Write atomically with strict permissions; never echo the blob.
umask 0177
TMPFILE="$(mktemp "${CODEX_HOME}/.auth.XXXXXX")"
printf '%s' "${OAUTH_BLOB}" > "${TMPFILE}"
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
