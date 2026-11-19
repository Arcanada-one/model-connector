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
rm -f "$assert_fn"

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
