#!/usr/bin/env bash
# Ports-env source-safety: only ^MC_FS_[A-Z_]+=[0-9]+$ lines are allowed.
set -euo pipefail
PATH=/usr/bin:/bin
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
SCRIPT="$ROOT/scripts/ci-full-suite-disposable-services.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass=0

# Extract assert_ports_env_file from the script without running start/stop.
assert_fn=$(mktemp)
awk '/^assert_ports_env_file\(\)/,/^}$/' "$SCRIPT" >"$assert_fn"
# shellcheck disable=SC1090
source "$assert_fn"
port_fn=$(mktemp)
awk '/^parse_published_port\(\)/,/^}$/' "$SCRIPT" >"$port_fn"
# shellcheck disable=SC1090
source "$port_fn"
rm -f "$assert_fn"
rm -f "$port_fn"

[[ "$(parse_published_port '127.0.0.1:32920')" == 32920 ]] || fail 'valid published port was not parsed'
pass=$((pass + 1))
if parse_published_port '127.0.0.1:1' >/dev/null 2>&1; then
  fail 'reserved port 1 was accepted as a Docker-published ephemeral port'
fi
pass=$((pass + 1))
if parse_published_port $'127.0.0.1:32920\n127.0.0.1:32921' >/dev/null 2>&1; then
  fail 'ambiguous multiple Docker port mappings were accepted'
fi
pass=$((pass + 1))
if parse_published_port '0.0.0.0:32920' >/dev/null 2>&1; then
  fail 'non-loopback published port mapping was accepted'
fi
pass=$((pass + 1))

# Exercise the start path with a fake Docker CLI. A dynamically published
# reserved port must fail before it is written into the ports env file.
fake_root=$(mktemp -d)
trap 'rm -rf -- "$fake_root"' EXIT
mkdir -m 700 "$fake_root/bin" "$fake_root/valid" "$fake_root/invalid"
cat >"$fake_root/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  run) printf 'fake-container-id\n' ;;
  exec)
    if [[ "$*" == *pg_isready* ]]; then exit 0; fi
    if [[ "$*" == *redis-cli* ]]; then printf 'PONG\n'; exit 0; fi
    exit 1
    ;;
  port)
    if [[ "$3" == 5432/tcp ]]; then printf '127.0.0.1:%s\n' "$FAKE_PG_PORT"; else printf '127.0.0.1:%s\n' "$FAKE_REDIS_PORT"; fi
    ;;
  rm) exit 0 ;;
  *) printf 'unexpected fake docker args: %s\n' "$*" >&2; exit 2 ;;
esac
DOCKER
chmod 700 "$fake_root/bin/docker"

env PATH="$fake_root/bin:/usr/bin:/bin" RUNNER_TEMP="$fake_root/valid" \
  GITHUB_RUN_ID=123 GITHUB_RUN_ATTEMPT=1 FAKE_PG_PORT=32920 FAKE_REDIS_PORT=32921 \
  bash "$SCRIPT" start >"$fake_root/valid.out" || fail 'start rejected valid Docker-published ports'
grep -Fxq 'MC_FS_PG_PORT=32920' "$fake_root/valid.out" || fail 'start did not publish parsed PostgreSQL port'
grep -Fxq 'MC_FS_REDIS_PORT=32921' "$fake_root/valid.out" || fail 'start did not publish parsed Redis port'
pass=$((pass + 1))

if env PATH="$fake_root/bin:/usr/bin:/bin" RUNNER_TEMP="$fake_root/invalid" \
  GITHUB_RUN_ID=124 GITHUB_RUN_ATTEMPT=1 FAKE_PG_PORT=1 FAKE_REDIS_PORT=32921 \
  bash "$SCRIPT" start >"$fake_root/invalid.out" 2>"$fake_root/invalid.err"; then
  fail 'start accepted Docker-published port 1'
fi
grep -q 'published port outside 1024-65535: 1' "$fake_root/invalid.err" \
  || fail 'start did not identify rejected published port 1'
pass=$((pass + 1))

good=$(mktemp)
printf 'MC_FS_PG_PORT=54321\nMC_FS_REDIS_PORT=63791\n' >"$good"
assert_ports_env_file "$good" || fail 'good ports env refused'
pass=$((pass + 1))
rm -f "$good"

bad_id=$(mktemp)
printf '7ef72aad2e19669129f186c3cc139da5bc14d92702850f1dd4d61d322200c8d0\nMC_FS_PG_PORT=1\nMC_FS_REDIS_PORT=2\n' >"$bad_id"
if assert_ports_env_file "$bad_id" 2>/dev/null; then
  fail 'docker id line was accepted'
fi
pass=$((pass + 1))
rm -f "$bad_id"

bad_key=$(mktemp)
printf 'MC_FS_PG_PORT=1\nFOO=2\n' >"$bad_key"
if assert_ports_env_file "$bad_key" 2>/dev/null; then
  fail 'non MC_FS_ line was accepted'
fi
pass=$((pass + 1))
rm -f "$bad_key"

missing=$(mktemp)
printf 'MC_FS_PG_PORT=1\n' >"$missing"
if assert_ports_env_file "$missing" 2>/dev/null; then
  fail 'missing REDIS port was accepted'
fi
pass=$((pass + 1))
rm -f "$missing"

# Script must discard docker run stdout ( >/dev/null ), not tee IDs into ports.env.
grep -q 'postgres:16 >/dev/null' "$SCRIPT" || fail 'postgres docker run must redirect stdout to /dev/null'
grep -q 'redis:7 >/dev/null' "$SCRIPT" || fail 'redis docker run must redirect stdout to /dev/null'
pass=$((pass + 1))

printf 'ci-full-suite-disposable-services.test.sh: %s PASS\n' "$pass"
