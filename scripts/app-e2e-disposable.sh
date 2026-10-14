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
OWN="mc-app-e2e-${HEAD:0:10}-$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
NET_ID='' PG_ID='' REDIS_ID=''
cleanup() {
  local primary=$? cleanup_failed=0
  trap - EXIT INT TERM
  if [[ -f "$META/reconcile.py" ]]; then
    timeout --signal=TERM --kill-after=5s 55s python3 "$META/reconcile.py" cleanup "$META" || cleanup_failed=1
  elif compgen -G "$META/*.intent.json" >/dev/null; then cleanup_failed=1; fi
  printf 'APP_E2E_PRIMARY_EXIT=%s CLEANUP_FAILED=%s\n' "$primary" "$cleanup_failed"
  if [[ $cleanup_failed == 0 ]]; then rm -rf -- "$META"; else echo "APP_E2E_CUSTODY_RETAINED=$META"; fi
  [[ $primary == 0 ]] || exit "$primary"
  [[ $cleanup_failed == 0 ]] || exit 127
}
create_owned() {
  local role=$1 name=$2 code=0 id=''
  shift 2
  python3 "$META/reconcile.py" intent "$META" "$role" "$OWN" "$HEAD" "$name" || return 127
  if id=$("$@"); then code=0; else code=$?; fi
  python3 "$META/reconcile.py" response "$META" "$role" "$code" "$id" || return 127
  [[ $code == 0 ]] || return "$code"
  printf '%s' "$id"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -c safe.directory="$ROOT" show "$HEAD:scripts/app-e2e-reconcile.py" > "$META/reconcile.py"
git -c safe.directory="$ROOT" show "$HEAD:scripts/app-e2e-snapshot.py" > "$META/export.py"
echo APP_E2E_PHASE=snapshot
timeout --signal=TERM --kill-after=5s 120s python3 "$META/export.py" "$ROOT" "$HEAD" "$META"
CUSTODY_SHA=$(sha256sum "$META/custody.json" | cut -d' ' -f1)
echo APP_E2E_PHASE=network_create
NET_ID=$(create_owned network "$OWN" timeout 5s docker network create --internal --label mc-run="$OWN" --label mc-role=network --label mc-head="$HEAD" "$OWN")
[[ "$NET_ID" =~ ^[a-f0-9]{64}$ ]] || exit 127
timeout 5s docker network inspect "$NET_ID" --format '{{.Internal}}' | test "$(cat)" = true
echo APP_E2E_PHASE=postgres_create
PG_ID=$(create_owned pg "$OWN-pg" timeout 5s docker run -d --cidfile "$META/pg.cid" --label mc-run="$OWN" --label mc-role=pg --label mc-head="$HEAD" --pull=never --name "$OWN-pg" --network "$NET_ID" --network-alias mc-pg --cpus=.25 --memory=512m --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=connector_test "$PG_IMAGE")
[[ "$PG_ID" =~ ^[a-f0-9]{64}$ ]] || exit 127
echo APP_E2E_PHASE=redis_create
REDIS_ID=$(create_owned redis "$OWN-redis" timeout 5s docker run -d --cidfile "$META/redis.cid" --label mc-run="$OWN" --label mc-role=redis --label mc-head="$HEAD" --pull=never --name "$OWN-redis" --network "$NET_ID" --network-alias mc-redis --cpus=.25 --memory=256m "$REDIS_IMAGE" redis-server --save '' --appendonly no)
[[ "$REDIS_ID" =~ ^[a-f0-9]{64}$ ]] || exit 127
printf 'APP_E2E_OWNED_IDS=%s %s %s\n' "$NET_ID" "$PG_ID" "$REDIS_ID"
echo APP_E2E_PHASE=stores_ready
for attempt in $(seq 1 30); do
  if timeout 1s docker exec "$PG_ID" pg_isready -h 127.0.0.1 -U test -d connector_test >/dev/null && timeout 1s docker exec "$REDIS_ID" redis-cli ping | test "$(cat)" = PONG; then break; fi
  [[ $attempt != 30 ]] || { echo 'APP_E2E_REFUSED: stores not ready'; exit 127; }
  sleep 1
done
# Each pre-dispatch phase is bounded; snapshot125s + setup40s + ready90s +
# app190s + custody65s leaves >40s cleanup inside the 600s owned envelope.
# Read-only exact source/dependencies. No host ports, inherited env, Docker socket,
# host credentials, image entrypoint or provider keys enter the application.
python3 "$META/reconcile.py" intent "$META" app "$OWN" "$HEAD" "$OWN-app"
echo APP_E2E_PHASE=app_dispatch
app_code=0
timeout --signal=TERM --kill-after=10s 180s docker run --rm --label mc-run="$OWN" --label mc-role=app --label mc-head="$HEAD" --pull=never --name "$OWN-app" --cidfile "$CID_FILE" --user "$(stat -c %u:%g "$ROOT/node_modules")" --network "$NET_ID" --cpus=1.5 --memory=2g --read-only --tmpfs /tmp:rw,size=256m,mode=1777 --cap-drop=ALL --security-opt=no-new-privileges -v "$META/source:/work:ro" -v "$META/dependencies/node_modules:/work/node_modules:ro" -w /work --entrypoint /bin/sh "$APP_IMAGE" -c 'env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp NODE_ENV=test DATABASE_URL=postgresql://test:test@mc-pg:5432/connector_test REDIS_HOST=mc-redis REDIS_PORT=6379 REDIS_PREFIX=mc-app-e2e STT_PROVIDER_GROQ_ENABLED=false MC_DISPOSABLE_APP_E2E=1 MC_NO_EGRESS=1 /bin/sh -ec "node node_modules/prisma/build/index.js migrate deploy; node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts --reporter=json --outputFile=/tmp/app-result.json; echo APP_E2E_RESULT_BEGIN; cat /tmp/app-result.json; echo APP_E2E_RESULT_END"' || app_code=$?
python3 "$META/reconcile.py" response "$META" app "$app_code" "$(cat "$CID_FILE" 2>/dev/null || true)"
[[ $app_code == 0 ]] || exit "$app_code"
echo APP_E2E_PHASE=post_custody
timeout --signal=TERM --kill-after=5s 60s python3 "$META/export.py" --verify "$META" "$CUSTODY_SHA"
echo "APP_E2E_SOURCE_HEAD=$HEAD"
