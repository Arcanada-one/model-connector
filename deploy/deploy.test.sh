#!/usr/bin/env bash
# Actual deploy entrypoint under command fixtures: no Docker or provider execution.
set -euo pipefail
passed=0
assert_absent() {
  local status=0
  /usr/bin/grep -Eq "$@" || status=$?
  [[ "$status" -eq 1 ]] || { echo 'FAIL forbidden output or unreadable fixture' >&2; exit 1; }
}
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
assert_absent ' up | down|exec ' "$COMMANDS"
passed=$((passed + 1))
: >"$COMMANDS"
bash "$fixture/repo/deploy/deploy.sh" >"$fixture/pass-output" 2>&1
mapfile -t commands <"$COMMANDS"
[[ "${commands[0]}" == 'compose -f docker-compose.yml -f docker-compose.codex.yml build' ]]
[[ "${commands[1]}" == 'compose -f docker-compose.yml -f docker-compose.codex.yml up -d --no-build' ]]
assert_absent ' down| logs' "$COMMANDS"
passed=$((passed + 1))
: >"$COMMANDS"
if FAIL_HEALTH=1 bash "$fixture/repo/deploy/deploy.sh" >"$fixture/health-output" 2>&1; then
  echo 'FAIL health failure accepted' >&2; exit 1
fi
assert_absent ' logs' "$COMMANDS"
assert_absent 'fixture-secret-never-log' "$fixture/fail-output" "$fixture/pass-output" "$fixture/health-output"
passed=$((passed + 1))
echo 'PASS deploy build-first, failed-build preserves runtime, health failure no logs'
printf '%s tests passed\n' "$passed"
