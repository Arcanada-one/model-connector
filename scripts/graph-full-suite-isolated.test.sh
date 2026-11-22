#!/usr/bin/env bash
# Unit test for graph-full-suite-isolated.sh: the private exec/home dir must be created
# outside /tmp (XDG_RUNTIME_DIR, then $HOME/.mcgs, then RUNNER_TEMP), mode 0700, removed on exit,
# and the script must fail closed when no private base is available, when $HOME/.mcgs is foreign,
# and (unit '.') when no base fits the AF_UNIX socket path budget.
#
# Why it matters: deploy/prime-first-install.py protected() refuses any path chain containing a
# group/other-writable directory, so a HOME under /tmp (mode 1777) made
# deploy/test_prime_first_install.py fail with Refusal(custody) regardless of the code under test.
#
# The heavy suite is replaced by a stub (graph-full-suite.sh) that records the TMPDIR/HOME it is given.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SUBJECT="$SCRIPT_DIR/graph-full-suite-isolated.sh"

# The harness itself must not live under /tmp either: assertions compare against the path prefix.
# Unit '.' success cases need a base that fits the AF_UNIX budget (base + 71 bytes < 108; case 11 uses
# $SHORT/rt, so $SHORT + 74 < 108). Inside the root full suite HOME and TMPDIR are the run's private dirs
# (for example /home/ci-runner/.mcgs/mcgs.XXXXXXXX/mc-full-.-XXXXXXXX/home), too deep for that budget, so
# the base is the first of HOME, TMPDIR, /dev/shm that passes every check below. Custody: the candidate is
# a directory outside /tmp and /var/tmp, owned by the caller or root, and, if group/other-writable, sticky
# (so no other user can rename what the harness creates in it); the fresh private dir is caller-owned,
# mode 0700, not a symlink, fits the budget, and can execute a file. None passing fails loudly; the
# cases are never skipped.
HARNESS_BASE=""
SHORT=""
tried=""
me="$(id -u)"
for cand in "${HOME:-}" "${TMPDIR:-}" /dev/shm; do
  [[ -n "$cand" && -d "$cand" && -w "$cand" ]] || { tried="$tried ${cand:-<unset>}(unusable)"; continue; }
  real="$(cd -- "$cand" && pwd -P)" || { tried="$tried $cand(unresolvable)"; continue; }
  case "$real/" in /tmp/*|/var/tmp/*) tried="$tried $cand(under /tmp)"; continue ;; esac
  read -r owner mode <<<"$(stat -c '%u %a' -- "$real")"
  [[ "$owner" == "$me" || "$owner" == 0 ]] || { tried="$tried $cand(foreign owner)"; continue; }
  if (( (8#$mode & 8#022) != 0 && (8#$mode & 8#1000) == 0 )); then
    tried="$tried $cand(group/other-writable, not sticky)"
    continue
  fi
  probe="$(mktemp -d "$real/.m.XXXXXX")" || { tried="$tried $cand(mktemp failed)"; continue; }
  chmod 700 "$probe"
  why=""
  if [[ -L "$probe" || "$(stat -c '%u %a' -- "$probe")" != "$me 700" ]]; then
    why="private dir custody"
  elif (( ${#probe} + 3 + 14 + 19 + 38 >= 108 )); then
    why="too long"
  else
    printf '#!/bin/sh\nexit 0\n' >"$probe/x" && chmod 700 "$probe/x" && "$probe/x" || why="cannot execute"
    rm -f -- "$probe/x"
  fi
  if [[ -n "$why" ]]; then
    rm -rf -- "${probe:?}"
    tried="$tried $cand($why)"
    continue
  fi
  HARNESS_BASE="$real"
  SHORT="$probe"
  break
done
if [[ -z "$SHORT" ]]; then
  echo "graph-full-suite-isolated.test.sh: no base fits the unit '.' budget cases (tried:$tried)" >&2
  exit 1
fi
WORK="$(mktemp -d "$HARNESS_BASE/.mcgs-isolated-test.XXXXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf -- "$WORK" "$SHORT"' EXIT
echo "graph-full-suite-isolated.test.sh: harness base $HARNESS_BASE" >&2

fail=0
check() { # check <name> <command...>
  local name=$1
  shift
  if "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    fail=1
  fi
}

# Fake checkout: <WORK>/repo/scripts/{graph-full-suite-isolated.sh,graph-full-suite.sh}, <WORK>/repo/node_modules
mkdir -p "$WORK/repo/scripts" "$WORK/repo/node_modules" "$WORK/runtime"
chmod 700 "$WORK/runtime"
cp "$SUBJECT" "$WORK/repo/scripts/graph-full-suite-isolated.sh"
cat >"$WORK/repo/scripts/graph-full-suite.sh" <<'STUB'
#!/usr/bin/env bash
# Stub: record where the isolated wrapper put TMPDIR and HOME.
out="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/observed"
{
  echo "TMPDIR=$TMPDIR"
  echo "HOME=$HOME"
  echo "TMPDIR_MODE=$(stat -c '%a' -- "$TMPDIR")"
  echo "COREPACK_HOME=${COREPACK_HOME:-}"
  echo "COREPACK_ENABLE_NETWORK=${COREPACK_ENABLE_NETWORK:-}"
  echo "PATH=$PATH"
  echo "DATABASE_URL=${DATABASE_URL:-}"
  echo "REDIS_HOST=${REDIS_HOST:-}"
  echo "REDIS_PORT=${REDIS_PORT:-}"
  echo "PROVIDER_API_KEY=${PROVIDER_API_KEY:-}"
} >"$out"
mkdir -m 700 "$TMPDIR/mc-full-fixture"
printf '{"status":"failed","test":"fixture only"}\n' >"$TMPDIR/mc-full-fixture/app-e2e.json"
STUB
chmod 755 "$WORK/repo/scripts/"*.sh
mkdir -m 700 "$WORK/pnpm-bin"
cat >"$WORK/pnpm-bin/pnpm" <<'PNPM'
#!/bin/sh
echo 10.30.3
PNPM
chmod 700 "$WORK/pnpm-bin/pnpm"
printf '{"packageManager":"pnpm@10.30.3"}\n' >"$WORK/repo/package.json"

run_unit() { # run_unit <deployable> <env assignments...>; leaves stdout/stderr in $WORK/run.log
  local unit=$1
  shift
  rm -f "$WORK/repo/observed"
  env -i PATH=/usr/bin:/bin "$@" bash "$WORK/repo/scripts/graph-full-suite-isolated.sh" "$unit" >"$WORK/run.log" 2>&1
}
# Base selection is checked on 'watcher', which binds no AF_UNIX socket, so the result does not depend
# on how deep this harness itself runs; the socket budget of unit '.' is checked separately below.
run_wrapper() { run_unit watcher "$@"; }
observed() { # a missing file reads as empty, so a refused run fails its named checks instead of aborting
  [[ -f "$WORK/repo/observed" ]] || return 0
  sed -n "s/^$1=//p" "$WORK/repo/observed"
}

not_under_tmp() { case "$1" in /tmp|/tmp/*|/var/tmp|/var/tmp/*) return 1 ;; *) return 0 ;; esac; }

# 1. XDG_RUNTIME_DIR is used: exec dir below it, not under /tmp, mode 0700, not group/other-writable.
run_wrapper XDG_RUNTIME_DIR="$WORK/runtime" || check "wrapper refused a run that must succeed (line $LINENO)" false
exec_dir="$(observed TMPDIR)"
check "unit watcher: AppE2E service endpoints do not cross the wrapper" \
  test -z "$(observed DATABASE_URL)" -a -z "$(observed REDIS_HOST)" -a -z "$(observed REDIS_PORT)"
check "xdg: exec dir is below XDG_RUNTIME_DIR" test "${exec_dir#"$WORK/runtime/"}" != "$exec_dir"
check "xdg: exec dir is not under /tmp" not_under_tmp "$exec_dir"
check "xdg: exec dir mode is 700" test "$(observed TMPDIR_MODE)" = 700
check "xdg: exec dir is not world-writable" test $((8#$(observed TMPDIR_MODE) & 8#002)) -eq 0
check "xdg: HOME handed to the suite is not under /tmp" not_under_tmp "$(observed HOME)"
check "xdg: exec dir removed on exit" test ! -e "$exec_dir"

check "service endpoint forwarding is an explicit three-name allowlist" grep -q \
  'for name in DATABASE_URL REDIS_HOST REDIS_PORT; do' "$SUBJECT"

# A failed AppE2E run keeps its JSON in runner.temp for the three-day CI artifact. The copied
# report is private, run-scoped, and the wrapper never prints its JSON contents.
run_unit watcher XDG_RUNTIME_DIR="$WORK/runtime" RUNNER_TEMP="$WORK/runtime" \
  GITHUB_RUN_ID=332 GITHUB_RUN_ATTEMPT=1 \
  || check "AppE2E report copy wrapper refused fixture" false
app_report="$WORK/runtime/model-connector-app-e2e-332-1.json"
check "AppE2E report copied to run-scoped runner.temp name" test -f "$app_report" -a ! -L "$app_report"
check "AppE2E report bytes are preserved" grep -qx '{"status":"failed","test":"fixture only"}' "$app_report"
check "AppE2E report is mode 600" test "$(stat -c '%a' "$app_report")" = 600
not_grep() { ! grep -q "$1" "$2"; }
check "AppE2E report fixture content is not printed" not_grep 'fixture only' "$WORK/run.log"
rm -f -- "$app_report"

# Setup-pnpm source is caller-owned, version-matched and precedes the scrubbed system PATH.
run_wrapper XDG_RUNTIME_DIR="$WORK/runtime" GRAPH_FULL_SUITE_PNPM_DIR="$WORK/pnpm-bin" \
  || check "pinned pnpm directory: wrapper refused a valid install (line $LINENO)" false
check "pinned pnpm directory: PATH reaches the isolated suite" bash -c \
  'case "$1" in "$2":*) exit 0 ;; *) exit 1 ;; esac' _ "$(observed PATH)" "$WORK/pnpm-bin"
cat >"$WORK/pnpm-bin/pnpm" <<'PNPM'
#!/bin/sh
echo 99.0.0
PNPM
chmod 700 "$WORK/pnpm-bin/pnpm"
if run_wrapper XDG_RUNTIME_DIR="$WORK/runtime" GRAPH_FULL_SUITE_PNPM_DIR="$WORK/pnpm-bin"; then
  check "pinned pnpm directory: mismatched version refuses" false
else
  check "pinned pnpm directory: mismatched version refuses before suite" \
    grep -q 'pinned pnpm reports 99.0.0, expected 10.30.3' "$WORK/run.log"
  check "pinned pnpm directory: mismatched version launches no suite" test ! -e "$WORK/repo/observed"
fi

# 2. RUNNER_TEMP is the fallback when XDG_RUNTIME_DIR is unset.
run_wrapper RUNNER_TEMP="$WORK/runtime" || check "wrapper refused a run that must succeed (line $LINENO)" false
exec_dir="$(observed TMPDIR)"
check "runner_temp: exec dir is below RUNNER_TEMP" test "${exec_dir#"$WORK/runtime/"}" != "$exec_dir"
check "runner_temp: exec dir is not under /tmp" not_under_tmp "$exec_dir"

# 3. Neither variable: fail closed with a clear message, no suite run.
if run_wrapper; then
  check "no base: wrapper fails closed" false
else
  check "no base: wrapper fails closed" test ! -e "$WORK/repo/observed"
  check "no base: message names XDG_RUNTIME_DIR" grep -q 'XDG_RUNTIME_DIR' "$WORK/run.log"
fi

# 4. A base under /tmp is refused.
if run_wrapper XDG_RUNTIME_DIR=/tmp; then
  check "tmp base: wrapper refuses /tmp" false
else
  check "tmp base: wrapper refuses /tmp" test ! -e "$WORK/repo/observed"
fi

# 5. A group/other-writable base is refused.
mkdir -m 777 "$WORK/open"
chmod 777 "$WORK/open"
if run_wrapper XDG_RUNTIME_DIR="$WORK/open"; then
  check "open base: wrapper refuses a world-writable base" false
else
  check "open base: wrapper refuses a world-writable base" test ! -e "$WORK/repo/observed"
fi

# 6. $HOME/.mcgs is used when XDG_RUNTIME_DIR is unset, before RUNNER_TEMP: created 0700, one
#    private run dir per invocation below it, removed on exit; .mcgs itself stays.
mkdir -m 700 "$WORK/h"
run_wrapper HOME="$WORK/h" RUNNER_TEMP="$WORK/runtime" || check "wrapper refused a run that must succeed (line $LINENO)" false
exec_dir="$(observed TMPDIR)"
check "home: exec dir is below \$HOME/.mcgs" test "${exec_dir#"$WORK/h/.mcgs/"}" != "$exec_dir"
check "home: .mcgs mode is 700" test "$(stat -c '%a' -- "$WORK/h/.mcgs")" = 700
check "home: run dir removed on exit" test ! -e "$exec_dir"
check "home: .mcgs kept for the next run" test -d "$WORK/h/.mcgs"
check "home: chosen base is logged" grep -q 'graph-full-suite-isolated: exec base from \$HOME/.mcgs' "$WORK/run.log"

# 7. XDG_RUNTIME_DIR still wins over $HOME/.mcgs.
run_wrapper XDG_RUNTIME_DIR="$WORK/runtime" HOME="$WORK/h" || check "wrapper refused a run that must succeed (line $LINENO)" false
exec_dir="$(observed TMPDIR)"
check "order: XDG_RUNTIME_DIR before \$HOME/.mcgs" test "${exec_dir#"$WORK/runtime/"}" != "$exec_dir"

# 8. A foreign $HOME/.mcgs (wrong mode, or a symlink) or a group/other-writable HOME is SKIPPED with its
#    reason, never used or repaired; the run falls through to the next candidate, and refuses when none is left.
mkdir -m 700 "$WORK/h2" && mkdir -m 755 "$WORK/h2/.mcgs" && chmod 755 "$WORK/h2/.mcgs"
run_wrapper HOME="$WORK/h2" RUNNER_TEMP="$WORK/runtime" || check "wrapper refused a run that must succeed (line $LINENO)" false
check "home: wrong-mode .mcgs skipped, RUNNER_TEMP used" test "$(observed TMPDIR | cut -c1-$((${#WORK} + 9)))" = "$WORK/runtime/"
check "home: wrong-mode .mcgs left as it was" test "$(stat -c '%a' -- "$WORK/h2/.mcgs")" = 755
check "home: wrong-mode skip is logged" grep -q 'skipped exec base candidate \$HOME/.mcgs: \$HOME/.mcgs is a symlink or not a caller-owned 0700 directory' "$WORK/run.log"
if run_wrapper HOME="$WORK/h2"; then
  check "home: wrong-mode .mcgs alone refuses" false
else
  check "home: wrong-mode .mcgs alone refuses" test ! -e "$WORK/repo/observed"
  check "home: refusal is FULL_FALLBACK_TEST_REFUSED" grep -q 'FULL_FALLBACK_TEST_REFUSED: no private exec base passes custody' "$WORK/run.log"
fi
mkdir -m 700 "$WORK/h3" && mkdir -m 700 "$WORK/h3-target" && ln -s "$WORK/h3-target" "$WORK/h3/.mcgs"
run_wrapper HOME="$WORK/h3" RUNNER_TEMP="$WORK/runtime" || check "wrapper refused a run that must succeed (line $LINENO)" false
check "home: symlinked .mcgs skipped" test "$(observed TMPDIR | cut -c1-$((${#WORK} + 9)))" = "$WORK/runtime/"
check "home: symlink target unused" test -z "$(ls -A -- "$WORK/h3-target")"
mkdir -m 700 "$WORK/h4" && chmod 775 "$WORK/h4"
run_wrapper HOME="$WORK/h4" RUNNER_TEMP="$WORK/runtime" || check "wrapper refused a run that must succeed (line $LINENO)" false
check "home: group-writable HOME skipped" test ! -e "$WORK/h4/.mcgs"
check "home: group-writable HOME skip is logged" grep -q 'skipped exec base candidate \$HOME/.mcgs: HOME is group/other-writable' "$WORK/run.log"

# 9. Unit '.': a base too deep for the AF_UNIX budget is never used (the 108-byte limit of
#    src/bench-reservation/composition.ts); with only such a base the wrapper refuses before the suite runs.
deep="$WORK/runtime-$(printf 'x%.0s' $(seq 1 48))"
mkdir -m 700 "$deep"
if run_unit . RUNNER_TEMP="$deep"; then
  check "budget: deep base refused for unit ." false
else
  check "budget: deep base refused for unit ." test ! -e "$WORK/repo/observed"
  check "budget: skip names the AF_UNIX budget" grep -q 'skipped exec base candidate RUNNER_TEMP: too deep for the 108-byte AF_UNIX path budget' "$WORK/run.log"
  check "budget: refusal is FULL_FALLBACK_TEST_REFUSED" grep -q 'FULL_FALLBACK_TEST_REFUSED: no private exec base passes custody and the 108-byte AF_UNIX path budget' "$WORK/run.log"
fi
# ... while the same deep base stays valid for a unit that binds no socket.
run_unit watcher RUNNER_TEMP="$deep" || check "wrapper refused a run that must succeed (line $LINENO)" false
check "budget: deep base still used for watcher" test "$(observed TMPDIR | cut -c1-${#deep})" = "$deep"

# 11. Fall-through for unit '.' (CI shape): XDG too deep, HOME custody-bad (group-writable), RUNNER_TEMP
#     short and private -> RUNNER_TEMP is used, and both skips are logged.
mkdir -m 700 "$SHORT/rt" "$WORK/h5" && chmod 775 "$WORK/h5"
#     This harness repo has no regression lock, so after choosing the base the wrapper refuses at the venv
#     step (the networked/hermetic unit '.' success path is dev-tools/graph-full-suite.test.py); the base
#     choice is read from the wrapper's own log line, and the refusal must be the LATER lock refusal.
run_unit . XDG_RUNTIME_DIR="$deep" HOME="$WORK/h5" RUNNER_TEMP="$SHORT/rt" || true
check "fallthrough: RUNNER_TEMP chosen after XDG and HOME skipped" grep -q 'graph-full-suite-isolated: exec base from RUNNER_TEMP' "$WORK/run.log"
check "fallthrough: stopped only at the later lock step" grep -q 'FULL_FALLBACK_TEST_REFUSED: regression lock file missing' "$WORK/run.log"
check "fallthrough: run dir removed" test -z "$(ls -A -- "$SHORT/rt")"
check "fallthrough: XDG skip logged" grep -q 'skipped exec base candidate XDG_RUNTIME_DIR: too deep' "$WORK/run.log"
check "fallthrough: HOME skip logged" grep -q 'skipped exec base candidate \$HOME/.mcgs: HOME is group/other-writable' "$WORK/run.log"

# 12. All three bad (XDG too deep, HOME custody-bad, RUNNER_TEMP world-writable): refuse, the suite never runs.
mkdir -m 700 "$WORK/open-rt" && chmod 777 "$WORK/open-rt"
if run_unit . XDG_RUNTIME_DIR="$deep" HOME="$WORK/h5" RUNNER_TEMP="$WORK/open-rt"; then
  check "fallthrough: all bad refuses" false
else
  check "fallthrough: all bad refuses" test ! -e "$WORK/repo/observed"
  check "fallthrough: RUNNER_TEMP custody skip logged" grep -q 'skipped exec base candidate RUNNER_TEMP: it is a symlink, not owned by the caller, or group/other-writable' "$WORK/run.log"
  check "fallthrough: all-bad refusal is FULL_FALLBACK_TEST_REFUSED" grep -q 'FULL_FALLBACK_TEST_REFUSED: no private exec base passes custody' "$WORK/run.log"
fi

# 10. Unit '.' regressions run in a private venv built from the hash-locked set (offline checks; the
#     networked install is exercised by every full-suite run of unit '.'). Every lock line is an exact
#     pin with one sha256, the set is exactly the jsonschema 4.23.0 closure, and the wrapper installs it
#     with --require-hashes --no-deps --only-binary=:all: under pip --isolated, refusing on failure.
lock="$(dirname -- "$SUBJECT")/graph-full-suite-regression.requirements.txt"
wrapper="$SUBJECT"
pins="$(grep -v -E '^(#|$)' "$lock" | sed -E 's/ --hash=sha256:[0-9a-f]{64}$//' | LC_ALL=C sort | tr '\n' ' ')"
check "lock: exact jsonschema 4.23.0 closure" test "$pins" = "attrs==24.3.0 jsonschema-specifications==2024.10.1 jsonschema==4.23.0 referencing==0.35.1 rpds-py==0.22.3 "
check "lock: every requirement has one sha256" test "$(grep -v -E '^(#|$)' "$lock" | grep -c -v -E '^[a-z0-9-]+==[0-9.]+ --hash=sha256:[0-9a-f]{64}$')" = 0
install_line="$(grep -A3 -E 'REG_VENV/bin/python" -I -m pip --isolated' "$wrapper" | tr -s ' \\\n' ' ')"
for flag in --require-hashes --no-deps --only-binary=:all: '-r "$REGRESSION_LOCK"' "refuse 'hash-locked regression dependencies could not be installed'"; do
  check "venv: pip install carries $flag" grep -q -F -- "$flag" <<<"$install_line"
done
check "venv: built without system site-packages" bash -c '! grep -q -- "--system-site-packages" "$1"' _ "$wrapper"
check "venv: locked jsonschema asserted inside the venv" grep -q -F 'md.version("jsonschema") == "4.23.0"' "$wrapper"

# 13. Evidence survives the wrapper. The suite's own "Full-suite evidence:" line names EXEC_TMP, which the EXIT
#     trap removes; the wrapper must print a LAST pointer to the surviving private copy, and on a non-zero status
#     a redacted failure digest capped at 64 KiB. A second fake checkout runs a stub suite that writes an
#     execution document and a raw log under TMPDIR; repo2/stub-mode holds "<status> <lines> <line bytes>".
mkdir -p "$WORK/repo2/scripts" "$WORK/repo2/node_modules"
cp "$SUBJECT" "$WORK/repo2/scripts/graph-full-suite-isolated.sh"
cat >"$WORK/repo2/scripts/graph-full-suite.sh" <<'STUB'
#!/usr/bin/env bash
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
read -r status lines width <"$root/stub-mode"
d="$(mktemp -d "$TMPDIR/mc-full-watcher-XXXXXXXX")"
# Token-shaped values are assembled at run time so no token- or key-shaped literal sits in the source. The PEM
# block is longer than the 80-line tail, so the tail starts inside it (no BEGIN line) and must still be redacted.
pfx=ghp pem='PRIVATE KEY'
{
  echo 'FIRST-LINE-OF-LOG'
  echo "-----BEGIN RSA $pem-----"
  for ((i = 0; i < 90; i++)); do echo "MIIharnessPEMbody${i}xyz"; done  # short: only the cut-PEM rule catches it
  echo "-----END RSA $pem-----"
  for ((i = 0; i < lines; i++)); do printf 'filler %0*d\n' "$width" "$i"; done
  echo "GITHUB_TOKEN=${pfx}_harnessfixture0123456789abcdef"
  echo 'Authorization: Bearer harnessbearer0123456789'
  echo 'dsn https://svc:harnesspassword@db.example/x'
  echo 'api_key="harnessapikeyvalue"'
  echo '{"OPENAI_KEY": "harnessjsonkeyvalue"}'
  echo 'payload harnessB64blobQWERTYuiopASDFGHjklZXCVBNm0123456789+/=='
  echo 'LAST-LINE-OF-LOG'
} >"$d/root-3-1.log"
ev=failed
[[ $status == 127 ]] && ev=not_measured
cat >"$d/execution.json" <<JSON
{"schema":"MaintainedFullSuiteExecution/v1","unit":"watcher","head":"stubhead","exit_code":$status,
 "results":[{"suite":"stub-regression","verdict":"failed","held_members":[],
  "executions":[{"verdict":"verified","exit_code":0,"duration_s":0.1,"argv":["python3","ok_test.py"],"raw_log":"$d/root-3-0.log"},
                {"verdict":"$ev","exit_code":$status,"duration_s":0.2,"argv":["env","HARNESS_SETTING=harnessenvvalue","python3","stub_test.py"],"raw_log":"$d/root-3-1.log"}]}]}
JSON
echo "Full-suite evidence: $d/execution.json"
exit "$status"
STUB
chmod 755 "$WORK/repo2/scripts/"*.sh
run_repo2() { # run_repo2 <status> <lines> <width>; output in $WORK/run2.log, wrapper status in $WORK/run2.rc
  echo "$1 $2 $3" >"$WORK/repo2/stub-mode"
  local rc=0
  env -i PATH=/usr/bin:/bin RUNNER_TEMP="$WORK/runtime" bash "$WORK/repo2/scripts/graph-full-suite-isolated.sh" watcher >"$WORK/run2.log" 2>&1 || rc=$?
  echo "$rc" >"$WORK/run2.rc"
}
last_pointer() { sed -n 's/^Full-suite evidence: //p' "$WORK/run2.log" | tail -1; }
digest() { sed -n '/^=== graph-full-suite failure digest/,$p' "$WORK/run2.log"; }
secret_free() { ! grep -q -E 'ghp_harness|harnessbearer|harnesspassword|harnessapikeyvalue|harnessenvvalue|harnessjsonkeyvalue|harnessPEMbody|harnessB64blob' "$WORK/run2.log"; }

run_repo2 1 200 8
ptr="$(last_pointer)"
check "evidence: wrapper keeps the suite's exit status" test "$(cat "$WORK/run2.rc")" = 1
check "evidence: two pointers, the suite's and the wrapper's" test "$(grep -c '^Full-suite evidence: ' "$WORK/run2.log")" = 2
check "evidence: last pointer exists after the wrapper exits" test -f "$ptr" -a ! -L "$ptr"
check "evidence: last pointer is the private copy" test "${ptr#"$WORK/repo2/node_modules/.cache/graph-full-suite/runs/run."}" != "$ptr"
check "evidence: first pointer (EXEC_TMP) is gone" test ! -e "$(sed -n 's/^Full-suite evidence: //p' "$WORK/run2.log" | head -1)"
check "evidence: private copy is byte-identical in content" grep -q '"head":"stubhead"' "$ptr"
check "digest: printed on failure" grep -q '^=== graph-full-suite failure digest' "$WORK/run2.log"
check "digest: names the failed execution's argv" grep -q -F 'python3 stub_test.py' "$WORK/run2.log"
check "digest: verified executions are not listed" bash -c '! grep -q -F "ok_test.py" "$1"' _ "$WORK/run2.log"
check "digest: tail holds the last log line" grep -q 'LAST-LINE-OF-LOG' "$WORK/run2.log"
check "digest: tail is at most 80 lines" test "$(digest | grep -c '^    | ')" -le 80
check "digest: older log lines are not printed" bash -c '! grep -q FIRST-LINE-OF-LOG "$1"' _ "$WORK/run2.log"
run_repo2 1 3 4
check "digest: env assignment in argv is redacted" grep -q -F 'HARNESS_SETTING=[REDACTED]' "$WORK/run2.log"
check "digest: token, bearer, URL password, key, JSON *_KEY, cut PEM, base64 run and env values redacted" secret_free
check "digest: redaction leaves the tail's last line" grep -q 'LAST-LINE-OF-LOG' "$WORK/run2.log"
run_repo2 127 3 4
check "not measured: status 127 kept" test "$(cat "$WORK/run2.rc")" = 127
check "not measured: last pointer printed" test -f "$(last_pointer)"
check "not measured: no failure digest without a failed execution" bash -c '! grep -q "failure digest" "$1"' _ "$WORK/run2.log"
run_repo2 0 3 4
check "evidence: last pointer also printed on success" test -f "$(last_pointer)"
check "digest: not printed on success" bash -c '! grep -q "failure digest" "$1"' _ "$WORK/run2.log"
check "evidence: success status kept" test "$(cat "$WORK/run2.rc")" = 0
run_repo2 1 79 3000
check "digest: capped at 64 KiB" test "$(digest | wc -c)" -le 65536
check "digest: cap is marked" grep -q '^\[digest truncated at 65536 bytes\]$' "$WORK/run2.log"

# 20. pnpm offline seed (GRAPH_FULL_SUITE_COREPACK). Unset: nothing changes. Set: the archive named by the
# exact packageManager pnpm must match the pinned sha256, or the run refuses before the suite.
run_wrapper XDG_RUNTIME_DIR="$WORK/runtime" || check "wrapper refused a run that must succeed (line $LINENO)" false
check "corepack unset: no COREPACK_HOME reaches the suite" test -z "$(observed COREPACK_HOME)"
check "corepack unset: no COREPACK_ENABLE_NETWORK reaches the suite" test -z "$(observed COREPACK_ENABLE_NETWORK)"
printf '{"name":"fixture","packageManager":"pnpm@10.30.3"}\n' >"$WORK/repo/package.json"
mkdir -m 700 "$WORK/seed"
printf 'not a corepack archive\n' >"$WORK/seed/pnpm-10.30.3.corepack.tgz"
good_sha="$(sha256sum "$WORK/seed/pnpm-10.30.3.corepack.tgz" | cut -d' ' -f1)"
pin() { printf '%s  %s\n' "$1" "$2" >"$WORK/repo/scripts/graph-full-suite-corepack.sha256"; }
refused_with() { # refused_with <name> <expected message> <env...>
  local name=$1 want=$2
  shift 2
  if run_wrapper XDG_RUNTIME_DIR="$WORK/runtime" "$@"; then
    check "$name: refused" false
  else
    check "$name: refused before the suite" test ! -e "$WORK/repo/observed"
    check "$name: names the reason" grep -q -F "$want" "$WORK/run.log"
  fi
}
pin "$(printf '0%.0s' {1..64})" pnpm-10.30.3.corepack.tgz
refused_with "corepack sha mismatch" 'does not match its pinned sha256' GRAPH_FULL_SUITE_COREPACK="$WORK/seed"
pin "$good_sha" pnpm-10.30.2.corepack.tgz
refused_with "corepack lock pins another version" 'corepack lock does not pin pnpm-10.30.3.corepack.tgz' GRAPH_FULL_SUITE_COREPACK="$WORK/seed"
rm -f "$WORK/repo/scripts/graph-full-suite-corepack.sha256"
refused_with "corepack lock missing" 'corepack lock file missing' GRAPH_FULL_SUITE_COREPACK="$WORK/seed"
pin "$good_sha" pnpm-10.30.3.corepack.tgz
ln -s "$WORK/seed" "$WORK/seed-link"
refused_with "corepack seed symlink" 'must be a directory, not a symlink' GRAPH_FULL_SUITE_COREPACK="$WORK/seed-link"
mkdir -m 700 "$WORK/seed-empty"
refused_with "corepack archive missing" 'corepack archive pnpm-10.30.3.corepack.tgz missing' GRAPH_FULL_SUITE_COREPACK="$WORK/seed-empty"
mv "$WORK/seed/pnpm-10.30.3.corepack.tgz" "$WORK/seed/real.tgz"
ln -s real.tgz "$WORK/seed/pnpm-10.30.3.corepack.tgz"
refused_with "corepack archive symlink" 'corepack archive pnpm-10.30.3.corepack.tgz missing' GRAPH_FULL_SUITE_COREPACK="$WORK/seed"
rm -f "$WORK/seed/pnpm-10.30.3.corepack.tgz"
mv "$WORK/seed/real.tgz" "$WORK/seed/pnpm-10.30.3.corepack.tgz"
printf '{"name":"fixture","packageManager":"pnpm@10"}\n' >"$WORK/repo/package.json"
refused_with "corepack loose packageManager" 'packageManager is not an exact pnpm version' GRAPH_FULL_SUITE_COREPACK="$WORK/seed"
printf '{"name":"fixture","packageManager":"pnpm@10.30.3"}\n' >"$WORK/repo/package.json"
# Positive control of the gate: the pinned bytes pass every check and reach `corepack install` offline;
# this fixture is not a real archive, so corepack itself refuses it. The real archive is measured outside
# this test (it is 4.6 MB and stays out of the repository).
refused_with "corepack pinned bytes reach the offline install" 'corepack could not install the pinned pnpm offline' GRAPH_FULL_SUITE_COREPACK="$WORK/seed"
rm -rf -- "${WORK:?}/seed" "${WORK:?}/seed-empty" "$WORK/seed-link" "$WORK/repo/package.json" "$WORK/repo/scripts/graph-full-suite-corepack.sha256"

if [[ $fail -ne 0 ]]; then
  echo "graph-full-suite-isolated.test.sh: FAILED"
  exit 1
fi
echo "graph-full-suite-isolated.test.sh: all checks passed"
