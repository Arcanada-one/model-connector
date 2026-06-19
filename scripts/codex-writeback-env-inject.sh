#!/usr/bin/env bash
# codex-writeback-env-inject.sh — operator helper for CONN-0222 milestone H1.6.
#
# Injects the writeback AppRole credentials into the prod .env (idempotent
# upsert) so the codex sidecar can authenticate its Vault writeback loop.
# Run AFTER `vault read auth/approle/role/codex-oauth-writeback/role-id` and
# `vault write -f .../secret-id` (H1 steps 5).
#
# Secrets are passed as arguments / env — NEVER hard-coded here, NEVER committed.
# The target .env is gitignored on the server; this script only writes to it.
#
# Usage (on arcana-prod, as the .env owner):
#   CODEX_WRITEBACK_ROLE_ID=<role-id> CODEX_WRITEBACK_SECRET_ID=<secret-id> \
#       scripts/codex-writeback-env-inject.sh [/path/to/.env]
#
# Default target: /srv/apps/model-connector/.env

set -euo pipefail

ENV_FILE="${1:-/srv/apps/model-connector/.env}"
ROLE_ID="${CODEX_WRITEBACK_ROLE_ID:-}"
SECRET_ID="${CODEX_WRITEBACK_SECRET_ID:-}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "${ROLE_ID}" ]   || die "CODEX_WRITEBACK_ROLE_ID is empty — export it before running."
[ -n "${SECRET_ID}" ] || die "CODEX_WRITEBACK_SECRET_ID is empty — export it before running."
[ -f "${ENV_FILE}" ]  || die "env file not found: ${ENV_FILE}"

# Idempotent upsert: replace the line if the key exists, else append.
# Uses a temp file + mv for atomicity; preserves file mode.
upsert() {
    local key="$1" val="$2" file="$3" tmp
    tmp="$(mktemp "${file}.XXXXXX")"
    # Copy existing lines except the target key, then append the fresh value.
    grep -v "^${key}=" "${file}" > "${tmp}" 2>/dev/null || true
    printf '%s=%s\n' "${key}" "${val}" >> "${tmp}"
    # Match the original file's permissions before swapping in.
    chmod --reference="${file}" "${tmp}" 2>/dev/null || chmod 600 "${tmp}"
    mv -f "${tmp}" "${file}"
}

# Back up once before mutating (timestamped, owner-only).
BACKUP="${ENV_FILE}.bak-conn0222-$(date -u +%Y%m%d-%H%M%S)"
cp -p "${ENV_FILE}" "${BACKUP}"
chmod 600 "${BACKUP}" 2>/dev/null || true

upsert CODEX_WRITEBACK_ROLE_ID   "${ROLE_ID}"   "${ENV_FILE}"
upsert CODEX_WRITEBACK_SECRET_ID "${SECRET_ID}" "${ENV_FILE}"

printf 'OK: injected CODEX_WRITEBACK_ROLE_ID + CODEX_WRITEBACK_SECRET_ID into %s\n' "${ENV_FILE}"
printf '    backup: %s\n' "${BACKUP}"
printf '    next: recreate the sidecar to pick up the new env:\n'
printf '      cd %s && docker compose -f docker-compose.yml -f docker-compose.codex.yml up -d codex-sidecar\n' \
    "$(dirname "${ENV_FILE}")"
