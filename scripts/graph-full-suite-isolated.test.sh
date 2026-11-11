#!/usr/bin/env bash
# Unit test for graph-full-suite-isolated.sh: the private exec/home dir must be created
# outside /tmp (XDG_RUNTIME_DIR, then RUNNER_TEMP), mode 0700, removed on exit, and the script
# must fail closed when no private base is available.
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

run_wrapper() { # run_wrapper <env assignments...>; leaves stdout/stderr in $WORK/run.log
  rm -f "$WORK/repo/observed"
  env -i PATH=/usr/bin:/bin "$@" bash "$WORK/repo/scripts/graph-full-suite-isolated.sh" . >"$WORK/run.log" 2>&1
}
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

if [[ $fail -ne 0 ]]; then
  echo "graph-full-suite-isolated.test.sh: FAILED"
  exit 1
fi
echo "graph-full-suite-isolated.test.sh: all checks passed"
