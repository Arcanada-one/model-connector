#!/usr/bin/env bash
# Start/stop 127.0.0.1-bound disposable Postgres+Redis and write a mode-0600 grant.
# Used by the graph-full-suite CI job. Never binds 0.0.0.0.
set -euo pipefail

usage() {
  printf 'usage: %s start|stop|grant\n' "$0" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
cmd=$1

: "${RUNNER_TEMP:?RUNNER_TEMP required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT required}"

STATE_DIR="$RUNNER_TEMP/mc-full-suite-services"
PG_NAME="mc-fs-pg-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
REDIS_NAME="mc-fs-redis-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
GRANT_PATH="$RUNNER_TEMP/mc-full-suite-grant.json"

start_services() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  # Ephemeral host ports, loopback-only.
  docker run -d --name "$PG_NAME" \
    -e POSTGRES_USER=test \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=connector_test \
    -p 127.0.0.1::5432 \
    postgres:16
  docker run -d --name "$REDIS_NAME" \
    -p 127.0.0.1::6379 \
    redis:7
  # Wait for health.
  for _ in $(seq 1 60); do
    if docker exec "$PG_NAME" pg_isready -U test >/dev/null 2>&1 \
      && docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null | grep -q PONG; then
      break
    fi
    sleep 1
  done
  docker exec "$PG_NAME" pg_isready -U test
  docker exec "$REDIS_NAME" redis-cli ping | grep -q PONG
  PG_PORT=$(docker port "$PG_NAME" 5432/tcp | awk -F: '{print $NF}' | tr -d '\r')
  REDIS_PORT=$(docker port "$REDIS_NAME" 6379/tcp | awk -F: '{print $NF}' | tr -d '\r')
  printf '%s\n' "$PG_PORT" >"$STATE_DIR/pg.port"
  printf '%s\n' "$REDIS_PORT" >"$STATE_DIR/redis.port"
  printf '%s\n' "$PG_NAME" >"$STATE_DIR/pg.name"
  printf '%s\n' "$REDIS_NAME" >"$STATE_DIR/redis.name"
  printf 'MC_FS_PG_PORT=%s\n' "$PG_PORT"
  printf 'MC_FS_REDIS_PORT=%s\n' "$REDIS_PORT"
}

write_grant() {
  PG_PORT=$(cat "$STATE_DIR/pg.port")
  REDIS_PORT=$(cat "$STATE_DIR/redis.port")
  PREFIX="mc-fs:${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}:"
  umask 077
  cat >"$GRANT_PATH" <<EOF
{
  "schema": "FullSuiteDisposableGrant/v1",
  "arms": ["integration-disposable-store", "app-e2e"],
  "env": {
    "DATABASE_URL": "postgresql://test:test@127.0.0.1:${PG_PORT}/connector_test",
    "REDIS_HOST": "127.0.0.1",
    "REDIS_PORT": "${REDIS_PORT}",
    "REDIS_PREFIX": "${PREFIX}",
    "STT_PROVIDER_GROQ_ENABLED": "false",
    "NODE_ENV": "test",
    "PORT": "3939",
    "MC_FULL_SUITE_APP_E2E": "1"
  }
}
EOF
  chmod 600 "$GRANT_PATH"
  printf 'MC_FULL_SUITE_GRANT=%s\n' "$GRANT_PATH"
}

stop_services() {
  if [[ -f "$STATE_DIR/pg.name" ]]; then
    docker rm -f "$(cat "$STATE_DIR/pg.name")" >/dev/null 2>&1 || true
  fi
  if [[ -f "$STATE_DIR/redis.name" ]]; then
    docker rm -f "$(cat "$STATE_DIR/redis.name")" >/dev/null 2>&1 || true
  fi
  rm -f "$GRANT_PATH"
  rm -rf "$STATE_DIR"
}

case "$cmd" in
  start) start_services ;;
  grant) write_grant ;;
  stop) stop_services ;;
  *) usage ;;
esac
