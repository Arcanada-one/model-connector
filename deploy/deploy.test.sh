#!/usr/bin/env bash
# Actual deploy entrypoint under command fixtures: no Docker or provider execution.
set -euo pipefail
subject="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/deploy.sh"
fixture="$(mktemp -d)"
trap 'rm -rf -- "${fixture}"' EXIT
mkdir -p "$fixture/repo/deploy" "$fixture/bin"
cp "$subject" "$fixture/repo/deploy/deploy.sh"
printf '%s\n' 'REDIS_HOST=100.97.136.74' 'SENTINEL_SECRET=fixture-secret-never-log' >"$fixture/repo/.env"
chmod 0600 "$fixture/repo/.env"
cat >"$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$COMMANDS"
if [[ "$*" == *" down"* || "$*" == *" logs"* ]]; then
  echo 'destructive or disclosure command refused' >&2
  exit 99
fi
if [[ "$*" == *" build"* && "${FAIL_BUILD:-0}" == 1 ]]; then exit 17; fi
if [[ "$*" == *'printenv BILLING_ENFORCED'* ]]; then echo true; fi
if [[ "$*" == *'test -n "$EMBEDDING_API_URL"'* && "${FAIL_EMBED_ENV:-0}" == 1 ]]; then exit 23; fi
MOCK
cat >"$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
[[ "${FAIL_HEALTH:-0}" != 1 ]]
MOCK
cat >"$fixture/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat >"$fixture/bin/git" <<'MOCK'
#!/usr/bin/env bash
printf '%040d\n' 1
MOCK
chmod 0755 "$fixture/bin/"*
export PATH="$fixture/bin:$PATH"
export COMMANDS="$fixture/commands"
: >"$COMMANDS"
if FAIL_BUILD=1 bash "$fixture/repo/deploy/deploy.sh" >"$fixture/fail-output" 2>&1; then
  echo 'FAIL build failure accepted' >&2; exit 1
fi
if rg -q ' up | down|exec ' "$COMMANDS"; then
  echo 'FAIL failed build changed runtime' >&2; exit 1
fi
: >"$COMMANDS"
bash "$fixture/repo/deploy/deploy.sh" >"$fixture/pass-output" 2>&1
mapfile -t commands <"$COMMANDS"
[[ "${commands[0]}" == 'compose -f docker-compose.yml -f docker-compose.codex.yml build' ]]
[[ "${commands[1]}" == 'compose -f docker-compose.yml -f docker-compose.codex.yml up -d --no-build' ]]
! rg -q ' down| logs' "$COMMANDS"
: >"$COMMANDS"
if FAIL_HEALTH=1 bash "$fixture/repo/deploy/deploy.sh" >"$fixture/health-output" 2>&1; then
  echo 'FAIL health failure accepted' >&2; exit 1
fi
! rg -q ' logs' "$COMMANDS"
! rg -q 'fixture-secret-never-log' "$fixture/fail-output" "$fixture/pass-output" "$fixture/health-output"
echo 'PASS deploy build-first, failed-build preserves runtime, health failure no logs'

# EMBEDDING_API_URL declaration: only an absent or blank key is filled, an operator value is kept.
declared='EMBEDDING_API_URL=http://100.90.7.20:8300'
embed_case() { # <name> <printf-format for .env> ; leaves the resulting file in $fixture/repo/.env
  printf "$2" >"$fixture/repo/.env"
  chmod 0600 "$fixture/repo/.env"
  bash "$fixture/repo/deploy/deploy.sh" >"$fixture/embed-$1" 2>&1 \
    || { echo "FAIL embed case $1 rejected" >&2; cat "$fixture/embed-$1" >&2; exit 1; }
}
count_key() { grep -c '^EMBEDDING_API_URL=' "$fixture/repo/.env" || true; }
embed_case absent 'REDIS_HOST=100.97.136.74\nSENTINEL_SECRET=fixture-secret-never-log\n'
[[ "$(count_key)" == 1 ]] && grep -qxF "$declared" "$fixture/repo/.env" || { echo 'FAIL absent key not declared once' >&2; exit 1; }
grep -qxF 'SENTINEL_SECRET=fixture-secret-never-log' "$fixture/repo/.env" || { echo 'FAIL other values changed' >&2; exit 1; }
embed_case nonewline 'REDIS_HOST=100.97.136.74\nSENTINEL_SECRET=fixture-secret-never-log'
grep -qxF 'SENTINEL_SECRET=fixture-secret-never-log' "$fixture/repo/.env" && grep -qxF "$declared" "$fixture/repo/.env" \
  || { echo 'FAIL missing final newline glued the new line' >&2; exit 1; }
embed_case operator 'REDIS_HOST=100.97.136.74\nEMBEDDING_API_URL=http://operator.example:9\n'
[[ "$(count_key)" == 1 ]] && grep -qxF 'EMBEDDING_API_URL=http://operator.example:9' "$fixture/repo/.env" \
  || { echo 'FAIL operator value not kept' >&2; exit 1; }
embed_case blank 'REDIS_HOST=100.97.136.74\nEMBEDDING_API_URL=\n'
[[ "$(count_key)" == 1 ]] && grep -qxF "$declared" "$fixture/repo/.env" || { echo 'FAIL blank key not filled' >&2; exit 1; }
embed_case quotedblank 'REDIS_HOST=100.97.136.74\nEMBEDDING_API_URL=""\n'
[[ "$(count_key)" == 1 ]] && grep -qxF "$declared" "$fixture/repo/.env" || { echo 'FAIL quoted blank key not filled' >&2; exit 1; }
embed_case commented 'REDIS_HOST=100.97.136.74\n# EMBEDDING_API_URL=http://old\n'
[[ "$(count_key)" == 1 ]] && grep -qxF "$declared" "$fixture/repo/.env" || { echo 'FAIL commented-out key not declared' >&2; exit 1; }
if FAIL_EMBED_ENV=1 bash "$fixture/repo/deploy/deploy.sh" >"$fixture/embed-missing-in-container" 2>&1; then
  echo 'FAIL deploy accepted a container without EMBEDDING_API_URL' >&2; exit 1
fi
! rg -q 'fixture-secret-never-log|100\.90\.7\.20' "$fixture"/embed-* || { echo 'FAIL deploy output printed an env value' >&2; exit 1; }
echo 'PASS EMBEDDING_API_URL declared once when absent or blank, operator value kept, presence asserted in container'
