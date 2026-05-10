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
AUTH_TARGET="${CODEX_HOME}/auth.json"

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

# CONN-0068 follow-up: cross-UID readability via /dev/shm bind. The
# `model-connector` container runs as UID 1001 (`connector` user from
# `useradd -m connector` on node:22-slim, where UID 1000 is taken by the
# base `node` user). Sidecar runs as root. Without this chown, MC's spawned
# `codex` cannot traverse ${CODEX_HOME} (mode 0700, root-owned) nor read
# auth.json (mode 0600, root-owned) → EACCES at first /execute call.
#
# Requires CAP_CHOWN in compose (`cap_add: [CHOWN]`) because `cap_drop: ALL`
# strips it from root by default. T-NEW preserved: file/dir remain mode
# 0600/0700; readable only by UID matching MC_USER_UID. Other containers on
# the same single-tenant host running as a different UID still cannot read.
MC_USER_UID="${MC_USER_UID:-1001}"
MC_USER_GID="${MC_USER_GID:-1001}"
# CONN-0080: keep ${CODEX_HOME} owned by root in container, share read+traverse
# with MC via group bit (dir = root:MC_GID 0750). On any restart (CI redeploy,
# host reboot, restart policy) sidecar enters as root — still owner of the dir
# → mktemp/mv work without CAP_DAC_OVERRIDE. The previous design chowned the
# dir to MC_USER_UID, which made subsequent restarts hit
# `mktemp: Permission denied` (EACCES) under `cap_drop: ALL`. T-NEW preserved:
# auth.json stays MC_UID:MC_GID 0600 — only MC user can read content; group-rx
# on the dir confers only traversal + readdir (filename `auth.json` is not a
# secret).
#
# Order matters for the first deploy after CONN-0079: PROD host dir is
# currently MC_UID:MC_GID 0700 (final state of the last successful pre-fix
# entrypoint run). chmod first would EPERM under cap_drop=ALL because we are
# not the owner and CAP_FOWNER is dropped. Reclaim ownership FIRST via
# CAP_CHOWN (works regardless of current owner), then chmod (we now own → no
# CAP_FOWNER needed). On steady state (root:MC_GID 0750) all three calls are
# idempotent.
if ! chown "0:${MC_USER_GID}" "${CODEX_HOME}"; then
    log "FATAL: chown ${CODEX_HOME} to 0:${MC_USER_GID} failed — likely missing CAP_CHOWN."
    log "Ensure 'cap_add: [CHOWN]' is set on codex-sidecar service in docker-compose.codex.yml."
    exit 73
fi
chmod 0750 "${CODEX_HOME}"
if ! chown "${MC_USER_UID}:${MC_USER_GID}" "${AUTH_TARGET}"; then
    log "FATAL: chown ${AUTH_TARGET} to ${MC_USER_UID}:${MC_USER_GID} failed — likely missing CAP_CHOWN."
    exit 73
fi
log "Set ${CODEX_HOME}=root:${MC_USER_GID} 0750, ${AUTH_TARGET}=${MC_USER_UID}:${MC_USER_GID} 0600 (CONN-0080)."

# Quick smoke — codex --version exercises auth.json parse path without spending tokens.
if ! codex --version >/dev/null 2>&1; then
    log "FATAL: codex --version failed after auth materialisation."
    exit 72
fi

log "Sidecar ready — codex $(codex --version 2>&1)"
exec "$@"
