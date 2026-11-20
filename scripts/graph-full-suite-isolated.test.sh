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
HARNESS_BASE="${HOME:?HOME required}"
WORK="$(mktemp -d "$HARNESS_BASE/.mcgs-isolated-test.XXXXXXXX")"
chmod 700 "$WORK"
# Unit '.' success cases need a base that fits the AF_UNIX budget (base + 71 bytes < 108), whatever depth
# WORK has on this host. A deliberately short private dir under HOME; a HOME too long for it fails loudly.
SHORT="$(mktemp -d "$HARNESS_BASE/.m.XXXXXX")"
chmod 700 "$SHORT"
trap 'rm -rf -- "$WORK" "$SHORT"' EXIT
if (( ${#SHORT} + 14 + 19 + 38 >= 108 )); then
  echo "graph-full-suite-isolated.test.sh: HOME $HARNESS_BASE is too long for the unit '.' budget cases" >&2
  exit 1
fi

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
} >"$out"
STUB
chmod 755 "$WORK/repo/scripts/"*.sh

run_unit() { # run_unit <deployable> <env assignments...>; leaves stdout/stderr in $WORK/run.log
  local unit=$1
  shift
  rm -f "$WORK/repo/observed"
  env -i PATH=/usr/bin:/bin "$@" bash "$WORK/repo/scripts/graph-full-suite-isolated.sh" "$unit" >"$WORK/run.log" 2>&1
}
# Base selection is checked on 'watcher', which binds no AF_UNIX socket, so the result does not depend
# on how deep this harness itself runs; the socket budget of unit '.' is checked separately below.
run_wrapper() { run_unit watcher "$@"; }
observed() { sed -n "s/^$1=//p" "$WORK/repo/observed"; }

not_under_tmp() { case "$1" in /tmp|/tmp/*|/var/tmp|/var/tmp/*) return 1 ;; *) return 0 ;; esac; }

# 1. XDG_RUNTIME_DIR is used: exec dir below it, not under /tmp, mode 0700, not group/other-writable.
run_wrapper XDG_RUNTIME_DIR="$WORK/runtime" || check "wrapper refused a run that must succeed (line $LINENO)" false
exec_dir="$(observed TMPDIR)"
check "xdg: exec dir is below XDG_RUNTIME_DIR" test "${exec_dir#"$WORK/runtime/"}" != "$exec_dir"
check "xdg: exec dir is not under /tmp" not_under_tmp "$exec_dir"
check "xdg: exec dir mode is 700" test "$(observed TMPDIR_MODE)" = 700
check "xdg: exec dir is not world-writable" test $((8#$(observed TMPDIR_MODE) & 8#002)) -eq 0
check "xdg: HOME handed to the suite is not under /tmp" not_under_tmp "$(observed HOME)"
check "xdg: exec dir removed on exit" test ! -e "$exec_dir"

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

if [[ $fail -ne 0 ]]; then
  echo "graph-full-suite-isolated.test.sh: FAILED"
  exit 1
fi
echo "graph-full-suite-isolated.test.sh: all checks passed"
