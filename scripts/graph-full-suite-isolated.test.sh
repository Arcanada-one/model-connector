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
trap 'rm -rf -- "$WORK"' EXIT

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
run_wrapper XDG_RUNTIME_DIR="$WORK/runtime"
exec_dir="$(observed TMPDIR)"
check "xdg: exec dir is below XDG_RUNTIME_DIR" test "${exec_dir#"$WORK/runtime/"}" != "$exec_dir"
check "xdg: exec dir is not under /tmp" not_under_tmp "$exec_dir"
check "xdg: exec dir mode is 700" test "$(observed TMPDIR_MODE)" = 700
check "xdg: exec dir is not world-writable" test $((8#$(observed TMPDIR_MODE) & 8#002)) -eq 0
check "xdg: HOME handed to the suite is not under /tmp" not_under_tmp "$(observed HOME)"
check "xdg: exec dir removed on exit" test ! -e "$exec_dir"

# 2. RUNNER_TEMP is the fallback when XDG_RUNTIME_DIR is unset.
run_wrapper RUNNER_TEMP="$WORK/runtime"
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
run_wrapper HOME="$WORK/h" RUNNER_TEMP="$WORK/runtime"
exec_dir="$(observed TMPDIR)"
check "home: exec dir is below \$HOME/.mcgs" test "${exec_dir#"$WORK/h/.mcgs/"}" != "$exec_dir"
check "home: .mcgs mode is 700" test "$(stat -c '%a' -- "$WORK/h/.mcgs")" = 700
check "home: run dir removed on exit" test ! -e "$exec_dir"
check "home: .mcgs kept for the next run" test -d "$WORK/h/.mcgs"

# 7. XDG_RUNTIME_DIR still wins over $HOME/.mcgs.
run_wrapper XDG_RUNTIME_DIR="$WORK/runtime" HOME="$WORK/h"
exec_dir="$(observed TMPDIR)"
check "order: XDG_RUNTIME_DIR before \$HOME/.mcgs" test "${exec_dir#"$WORK/runtime/"}" != "$exec_dir"

# 8. A foreign $HOME/.mcgs (wrong mode, or a symlink) is refused, not skipped.
mkdir -m 700 "$WORK/h2" && mkdir -m 755 "$WORK/h2/.mcgs" && chmod 755 "$WORK/h2/.mcgs"
if run_wrapper HOME="$WORK/h2" RUNNER_TEMP="$WORK/runtime"; then
  check "home: wrong-mode .mcgs refused" false
else
  check "home: wrong-mode .mcgs refused" test ! -e "$WORK/repo/observed"
  check "home: wrong-mode refusal is FULL_FALLBACK_TEST_REFUSED" grep -q 'FULL_FALLBACK_TEST_REFUSED' "$WORK/run.log"
fi
mkdir -m 700 "$WORK/h3" && ln -s "$WORK/runtime" "$WORK/h3/.mcgs"
if run_wrapper HOME="$WORK/h3" RUNNER_TEMP="$WORK/runtime"; then
  check "home: symlinked .mcgs refused" false
else
  check "home: symlinked .mcgs refused" test ! -e "$WORK/repo/observed"
fi

# 9. Unit '.': a base too deep for the AF_UNIX budget is never used. With only such a base the
#    wrapper refuses before the suite runs (the 108-byte limit of src/bench-reservation/composition.ts).
deep="$WORK/runtime-$(printf 'x%.0s' $(seq 1 48))"
mkdir -m 700 "$deep"
if run_unit . RUNNER_TEMP="$deep"; then
  check "budget: deep base refused for unit ." false
else
  check "budget: deep base refused for unit ." test ! -e "$WORK/repo/observed"
  check "budget: refusal names the AF_UNIX budget" grep -q 'FULL_FALLBACK_TEST_REFUSED: no private exec base fits the 108-byte AF_UNIX path budget' "$WORK/run.log"
fi
# ... while the same deep base stays valid for a unit that binds no socket.
run_unit watcher RUNNER_TEMP="$deep"
check "budget: deep base still used for watcher" test "$(observed TMPDIR | cut -c1-${#deep})" = "$deep"

if [[ $fail -ne 0 ]]; then
  echo "graph-full-suite-isolated.test.sh: FAILED"
  exit 1
fi
echo "graph-full-suite-isolated.test.sh: all checks passed"
