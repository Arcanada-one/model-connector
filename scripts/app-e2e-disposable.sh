#!/usr/bin/env bash
# Owned, bounded, internal-network AppModule execution; no production authority.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
[[ "$PWD" == "$ROOT" && -z $(git status --porcelain --untracked-files=no) ]] || { echo 'APP_E2E_REFUSED: clean source root required'; exit 127; }
for f in .env .env.local .env.integration .env.test; do
  [[ ! -e "$ROOT/$f" && ! -L "$ROOT/$f" ]] || { echo 'APP_E2E_REFUSED: ambient dotenv'; exit 127; }
done
docker info >/dev/null 2>&1 || { echo 'APP_E2E_REFUSED: Docker API unavailable'; exit 127; }
# Never pull or build; capacity/image readiness is a separately owned precondition.
for image in postgres:16 redis:7 model-connector-e2e:latest; do
  docker image inspect "$image" --format '{{.Id}}' || exit 127
done
HEAD=$(git rev-parse HEAD)
OWN="mc-app-e2e-${HEAD:0:10}-$$"
cleanup() {
  docker rm -f "$OWN-app" "$OWN-pg" "$OWN-redis" >/dev/null 2>&1 || true
  docker network rm "$OWN" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker network create --internal --label mc-owned="$OWN" "$OWN" >/dev/null
docker network inspect "$OWN" --format '{{.Internal}}' | test "$(cat)" = true
docker run -d --pull=never --name "$OWN-pg" --network "$OWN" --network-alias mc-pg --cpus=.25 --memory=512m --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=connector_test postgres:16 >/dev/null
docker run -d --pull=never --name "$OWN-redis" --network "$OWN" --network-alias mc-redis --cpus=.25 --memory=256m redis:7 redis-server --save '' --appendonly no >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$OWN-pg" pg_isready -U test -d connector_test >/dev/null && docker exec "$OWN-redis" redis-cli ping | test "$(cat)" = PONG; then break; fi
  [[ $attempt != 30 ]] || { echo 'APP_E2E_REFUSED: stores not ready'; exit 127; }
  sleep 1
done
# Read-only exact source/dependencies. No host ports, inherited env, Docker socket,
# host credentials, image entrypoint or provider keys enter the application.
timeout --signal=TERM --kill-after=10s 180s docker run --rm --pull=never --name "$OWN-app" --network "$OWN" --cpus=1.5 --memory=2g --read-only --tmpfs /tmp:rw,size=256m,mode=1777 --cap-drop=ALL --security-opt=no-new-privileges -v "$ROOT:/work:ro" -w /work --entrypoint /bin/sh model-connector-e2e:latest -c 'env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp NODE_ENV=test DATABASE_URL=postgresql://test:test@mc-pg:5432/connector_test REDIS_HOST=mc-redis REDIS_PORT=6379 REDIS_PREFIX=mc-app-e2e STT_PROVIDER_GROQ_ENABLED=false MC_DISPOSABLE_APP_E2E=1 MC_NO_EGRESS=1 /bin/sh -ec "node node_modules/prisma/build/index.js migrate deploy; node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts --reporter=json --outputFile=/tmp/app-result.json; echo APP_E2E_RESULT_BEGIN; cat /tmp/app-result.json; echo APP_E2E_RESULT_END"'
echo "APP_E2E_SOURCE_HEAD=$HEAD"
