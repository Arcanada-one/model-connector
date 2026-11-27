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

# Ports/grant stdout must be source-safe: only KEY=VALUE, never docker IDs.
assert_ports_env_file() {
  local file=$1
  if [[ ! -f "$file" ]]; then
    printf 'ci-full-suite-disposable-services: missing ports env file\n' >&2
    return 1
  fi
  if grep -Eqv '^MC_FS_[A-Z_]+=[0-9]+$' "$file"; then
    printf 'ci-full-suite-disposable-services: ports env has non KEY=digits lines:\n' >&2
    grep -Ev '^MC_FS_[A-Z_]+=[0-9]+$' "$file" >&2 || true
    return 1
  fi
  if ! grep -Eq '^MC_FS_PG_PORT=[0-9]+$' "$file" \
    || ! grep -Eq '^MC_FS_REDIS_PORT=[0-9]+$' "$file"; then
    printf 'ci-full-suite-disposable-services: required MC_FS_*_PORT lines missing\n' >&2
    return 1
  fi
  return 0
}

parse_published_port() { # parse_published_port <docker port output>
  local mapping=$1 port
  if [[ ! "$mapping" =~ ^127\.0\.0\.1:([0-9]{1,5})$ ]]; then
    printf 'ci-full-suite-disposable-services: unexpected docker port mapping: %s\n' "$mapping" >&2
    return 1
  fi
  port=$((10#${BASH_REMATCH[1]}))
  if (( port < 1024 || port > 65535 )); then
    printf 'ci-full-suite-disposable-services: published port outside 1024-65535: %s\n' "$port" >&2
    return 1
  fi
  printf '%s\n' "$port"
}

start_services() {
  mkdir -m 700 -- "$STATE_DIR"
  trap 'rc=$?; if (( rc != 0 )); then stop_services || true; fi' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # Container IDs go to /dev/null; docker errors stay on stderr. Stdout is
  # only KEY=value so the workflow can tee/source without executing hex IDs.
  # Record the name before docker run, which can create a container and then fail.
  printf '%s\n' "$PG_NAME" >"$STATE_DIR/pg.name"
  docker run -d --name "$PG_NAME" \
    -e POSTGRES_USER=test \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=connector_test \
    -p 127.0.0.1::5432 \
    postgres:16 >/dev/null
  printf '%s\n' "$REDIS_NAME" >"$STATE_DIR/redis.name"
  docker run -d --name "$REDIS_NAME" \
    -p 127.0.0.1::6379 \
    redis:7 >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$PG_NAME" pg_isready -U test >/dev/null 2>&1 \
      && docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null | grep -q PONG; then
      break
    fi
    sleep 1
  done
  docker exec "$PG_NAME" pg_isready -U test >/dev/null
  docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null | grep -q PONG
  PG_PORT=$(parse_published_port "$(docker port "$PG_NAME" 5432/tcp | tr -d '\r')")
  REDIS_PORT=$(parse_published_port "$(docker port "$REDIS_NAME" 6379/tcp | tr -d '\r')")
  printf '%s\n' "$PG_PORT" >"$STATE_DIR/pg.port"
  printf '%s\n' "$REDIS_PORT" >"$STATE_DIR/redis.port"
  {
    printf 'MC_FS_PG_PORT=%s\n' "$PG_PORT"
    printf 'MC_FS_REDIS_PORT=%s\n' "$REDIS_PORT"
  } >"$STATE_DIR/ports.env"
  assert_ports_env_file "$STATE_DIR/ports.env" || exit 1
  cat "$STATE_DIR/ports.env"
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
    "HOST": "127.0.0.1",
    "PORT": "3939",
    "MC_FULL_SUITE_APP_E2E": "1"
  }
}
EOF
  chmod 600 "$GRANT_PATH"
  printf 'MC_FULL_SUITE_GRANT=%s\n' "$GRANT_PATH"
}

remove_recorded_container() {
  local record=$1 expected=$2 name error
  [[ -f "$record" ]] || return 0
  name=$(cat "$record") || return 1
  if [[ "$name" != "$expected" ]]; then
    printf 'Unexpected container name in %s\n' "$record" >&2
    return 1
  fi
  if ! error=$(LC_ALL=C docker rm -fv "$name" 2>&1) \
    && [[ "$error" != "Error response from daemon: No such container: $name" ]]; then
    printf '%s\n' "$error" >&2
    return 1
  fi
}

stop_services() {
  local failed=0
  remove_recorded_container "$STATE_DIR/pg.name" "$PG_NAME" || failed=1
  remove_recorded_container "$STATE_DIR/redis.name" "$REDIS_NAME" || failed=1
  rm -f -- "$GRANT_PATH" || failed=1
  # Keep the names when teardown fails so the workflow can retry.
  (( failed == 0 )) || return 1
  rm -rf -- "$STATE_DIR"
}

case "$cmd" in
  start) start_services ;;
  grant) write_grant ;;
  stop) stop_services ;;
  *) usage ;;
esac
