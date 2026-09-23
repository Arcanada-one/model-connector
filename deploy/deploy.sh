#!/usr/bin/env bash
# Model Connector — production deploy.
#
# INFRA-0417: this was a 40-line script inlined into an `appleboy/ssh-action`
# step, executed over SSH against a host named by the DEPLOY_HOST secret. Three
# things were wrong with that shape, independently of which machine it pointed
# at:
#
#   * The deploy target was invisible. Nothing in the workflow said which
#     machine would be changed, so it could not be reviewed and could not be
#     moved without editing a secret. SEC-0063 exists because of exactly this:
#     a host is selected by a runner label, never by an address in config.
#   * The deploy logic was not in the repository. It lived in a YAML string, so
#     it was not lintable, not testable, and not diffable as code.
#   * The job held an SSH private key with shell access to a production host.
#
# It now runs as root from the broker's own checkout, on a host-unique label.
# The runner supplies no content: not this script, not the compose files, not
# the environment.
#
# Behaviour is otherwise unchanged from the inline version — the same build,
# the same overlay, the same three post-deploy assertions, in the same order.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root == the broker checkout

if [[ ! -f .env ]]; then
  echo "FATAL: .env missing. The broker installs it on sync; run sync first." >&2
  exit 1
fi

# INFRA-0280 moved Redis from Arcana-KB to Arcana-DBS. Migrate only the known
# stale endpoint and preserve every other value in the env file.
if grep -qx 'REDIS_HOST=100.70.137.104' .env; then
  sed -i 's/^REDIS_HOST=100\.70\.137\.104$/REDIS_HOST=100.97.136.74/' .env
fi
grep -qx 'REDIS_HOST=100.97.136.74' .env \
  || { echo 'FAIL: REDIS_HOST does not point to Arcana-DBS'; exit 1; }

# CONN-0073: layer the codex overlay so codex env (CODEX_BINARY_PATH,
# CODEX_HOME, CODEX_VAULT_ROLE_ID, CODEX_VAULT_SECRET_ID) and the codex-bin /
# dev-shm volumes are applied to the model-connector container alongside the
# codex-sidecar service.
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.codex.yml)

# CONN-0208: clean up orphan containers before recreate (race condition);
# named volumes are preserved.
# A2-228: bake the deployed commit into the image so /health can name it. Read from the
# broker's own checkout, which is the thing being deployed. A checkout that cannot answer
# leaves this empty, and /health then reports no build rather than a wrong one.
MC_BUILD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
export MC_BUILD_SHA
echo "[deploy] building MC_BUILD_SHA=${MC_BUILD_SHA:-(unknown)}"

"${COMPOSE[@]}" down --remove-orphans || true
"${COMPOSE[@]}" up -d --build

sleep 10
curl -fsS http://127.0.0.1:3900/health || { "${COMPOSE[@]}" logs --tail=50; exit 1; }

# ARAS-0071: apply schema migrations. Without this a schema change deploys as
# CODE WITHOUT SCHEMA — which is exactly what happened to the credits tables:
# they were created in test databases by `prisma db push` (which writes no
# migration file), so every suite was green while production had no tables at
# all. The failure was silent, because the settle path is non-fatal by design
# and simply logged. Running it AFTER the health check keeps the ordering
# honest: the container is already up and serving, so a migration failure is a
# loud deploy failure rather than a boot loop.
docker exec model-connector-model-connector-1 \
  npx prisma migrate deploy \
  || { echo "FAIL: prisma migrate deploy"; exit 1; }

docker exec model-connector-model-connector-1 sh -c \
  'test -n "$CODEX_BINARY_PATH" && test -n "$CODEX_HOME" && test -n "$CODEX_VAULT_ROLE_ID" && test -n "$CODEX_VAULT_SECRET_ID"' \
  || { echo "FAIL CONN-0073: codex overlay env not applied"; exit 1; }

# ARAS-0058: assert the billing switch actually reached the running container.
# It used to be set by hand and declared nowhere, so a rebuild of .env from the
# template would drop it — and the symptom of dropping it is that everything
# keeps working, for free. Deliberately fatal rather than a warning: a warning
# in a deploy log is indistinguishable from the silence it is meant to replace.
docker exec model-connector-model-connector-1 sh -c 'test -n "$BILLING_ENFORCED"' || {
  echo "FAIL ARAS-0058: BILLING_ENFORCED is not set in the container env."
  echo "  Add an explicit BILLING_ENFORCED=<true|false> line to the root-owned"
  echo "  env file the broker installs — the schema default (false) means an"
  echo "  absent value disables billing SILENTLY, which is the exact failure"
  echo "  this check exists to make loud."
  exit 1
}
echo "ARAS-0058: BILLING_ENFORCED=$(docker exec model-connector-model-connector-1 printenv BILLING_ENFORCED)"

echo "Deploy successful: $("${COMPOSE[@]}" ps --format '{{.Name}} {{.Status}}')"
