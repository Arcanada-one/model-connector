#!/usr/bin/env bash
# Owned, bounded, internal-network AppModule execution; no production authority.
set -euo pipefail
ROOT=$(pwd -P)
[[ "$(git -c safe.directory="$ROOT" rev-parse --show-toplevel)" == "$ROOT" && -z $(git -c safe.directory="$ROOT" status --porcelain --untracked-files=no) ]] || { echo 'APP_E2E_REFUSED: clean source root required'; exit 127; }
for f in .env .env.local .env.integration .env.test; do
  [[ ! -e "$ROOT/$f" && ! -L "$ROOT/$f" ]] || { echo 'APP_E2E_REFUSED: ambient dotenv'; exit 127; }
done
timeout 5s docker info >/dev/null 2>&1 || { echo 'APP_E2E_REFUSED: Docker API unavailable'; exit 127; }
# Never pull or build; capacity/image readiness is a separately owned precondition.
pin_image() {
  local id
  id=$(timeout 5s docker image inspect "$1" --format '{{.Id}}') || return 127
  [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 127
  printf '%s' "$id"
}
PG_IMAGE=$(pin_image postgres:16)
REDIS_IMAGE=$(pin_image redis:7)
APP_IMAGE=$(pin_image model-connector-e2e:latest)
printf 'APP_E2E_IMAGE_IDS=%s %s %s\n' "$PG_IMAGE" "$REDIS_IMAGE" "$APP_IMAGE"
HEAD=$(git -c safe.directory="$ROOT" rev-parse HEAD)
[[ "${MC_APP_E2E_EXPECTED_HEAD:-$HEAD}" == "$HEAD" ]] || { echo "APP_E2E_REFUSED: wrong head"; exit 127; }
META=$(mktemp -d "${TMPDIR:-/tmp}/mc-app-cid.XXXXXX")
CID_FILE="$META/app.cid"
OWN="mc-app-e2e-${HEAD:0:10}-$(basename "$META")"
NET_ID='' PG_ID='' REDIS_ID=''
cleanup() {
  local primary=$? cleanup_failed=0 id ids=()
  trap - EXIT INT TERM
  [[ ! -f "$CID_FILE" ]] || ids+=("$(cat "$CID_FILE")")
  ids+=("$PG_ID" "$REDIS_ID")
  for id in "${ids[@]}"; do
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || continue
    timeout 5s docker rm -f "$id" >/dev/null 2>&1 || cleanup_failed=1
    # A successful inventory read is mandatory; absence is an empty exact-ID list.
    residual=$(timeout 5s docker ps -aq --no-trunc --filter "id=$id") || cleanup_failed=1
    [[ -z "${residual-unknown}" ]] || cleanup_failed=1
  done
  if [[ "$NET_ID" =~ ^[a-f0-9]{64}$ ]]; then
    timeout 5s docker network rm "$NET_ID" >/dev/null 2>&1 || cleanup_failed=1
    residual=$(timeout 5s docker network ls -q --no-trunc --filter "id=$NET_ID") || cleanup_failed=1
    [[ -z "${residual-unknown}" ]] || cleanup_failed=1
  fi
  printf 'APP_E2E_PRIMARY_EXIT=%s CLEANUP_FAILED=%s\n' "$primary" "$cleanup_failed"
  # Preserve failed custody and diagnostics; remove only our private successful export.
  if [[ $cleanup_failed == 0 ]]; then rm -rf -- "$META"; fi
  [[ $primary == 0 ]] || exit "$primary"
  [[ $cleanup_failed == 0 ]] || exit 127
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -c safe.directory="$ROOT" show "$HEAD:scripts/app-e2e-snapshot.py" > "$META/export.py"
timeout --signal=TERM --kill-after=5s 120s python3 "$META/export.py" "$ROOT" "$HEAD" "$META"
CUSTODY_SHA=$(sha256sum "$META/custody.json" | cut -d' ' -f1)
NET_ID=$(timeout 5s docker network create --internal --label mc-owned="$OWN" "$OWN")
[[ "$NET_ID" =~ ^[a-f0-9]{64}$ ]] || exit 127
timeout 5s docker network inspect "$NET_ID" --format '{{.Internal}}' | test "$(cat)" = true
PG_ID=$(timeout 5s docker run -d --pull=never --name "$OWN-pg" --network "$NET_ID" --network-alias mc-pg --cpus=.25 --memory=512m --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=connector_test "$PG_IMAGE")
[[ "$PG_ID" =~ ^[a-f0-9]{64}$ ]] || exit 127
REDIS_ID=$(timeout 5s docker run -d --pull=never --name "$OWN-redis" --network "$NET_ID" --network-alias mc-redis --cpus=.25 --memory=256m "$REDIS_IMAGE" redis-server --save '' --appendonly no)
[[ "$REDIS_ID" =~ ^[a-f0-9]{64}$ ]] || exit 127
printf 'APP_E2E_OWNED_IDS=%s %s %s\n' "$NET_ID" "$PG_ID" "$REDIS_ID"
for attempt in $(seq 1 30); do
  if timeout 1s docker exec "$PG_ID" pg_isready -U test -d connector_test >/dev/null && timeout 1s docker exec "$REDIS_ID" redis-cli ping | test "$(cat)" = PONG; then break; fi
  [[ $attempt != 30 ]] || { echo 'APP_E2E_REFUSED: stores not ready'; exit 127; }
  sleep 1
done
# Each pre-dispatch phase is bounded; snapshot125s + setup40s + ready90s +
# app190s + custody65s leaves >40s cleanup inside the 600s owned envelope.
# Read-only exact source/dependencies. No host ports, inherited env, Docker socket,
# host credentials, image entrypoint or provider keys enter the application.
timeout --signal=TERM --kill-after=10s 180s docker run --rm --pull=never --name "$OWN-app" --cidfile "$CID_FILE" --user "$(stat -c %u:%g "$ROOT/node_modules")" --network "$NET_ID" --cpus=1.5 --memory=2g --read-only --tmpfs /tmp:rw,size=256m,mode=1777 --cap-drop=ALL --security-opt=no-new-privileges -v "$META/source:/work:ro" -v "$META/dependencies/node_modules:/work/node_modules:ro" -w /work --entrypoint /bin/sh "$APP_IMAGE" -c 'env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp NODE_ENV=test DATABASE_URL=postgresql://test:test@mc-pg:5432/connector_test REDIS_HOST=mc-redis REDIS_PORT=6379 REDIS_PREFIX=mc-app-e2e STT_PROVIDER_GROQ_ENABLED=false MC_DISPOSABLE_APP_E2E=1 MC_NO_EGRESS=1 /bin/sh -ec "node node_modules/prisma/build/index.js migrate deploy; node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts --reporter=json --outputFile=/tmp/app-result.json; echo APP_E2E_RESULT_BEGIN; cat /tmp/app-result.json; echo APP_E2E_RESULT_END"'
timeout --signal=TERM --kill-after=5s 60s python3 "$META/export.py" --verify "$META" "$CUSTODY_SHA"
echo "APP_E2E_SOURCE_HEAD=$HEAD"
