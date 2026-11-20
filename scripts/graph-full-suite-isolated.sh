#!/usr/bin/env bash
# Prepare the private environment required by graph-full-suite.sh under the
# graph verifier's deliberately minimal child environment.
set -euo pipefail
PATH=/usr/bin:/bin
export PATH
if [[ $# != 1 ]]; then
  echo 'FULL_FALLBACK_TEST_REFUSED: exactly one deployable is required' >&2
  exit 1
fi
case "$1" in
  .|packages/sdk-python|packages/sdk-ts|watcher) ;;
  *) echo 'FULL_FALLBACK_TEST_REFUSED: undeclared deployable' >&2; exit 1 ;;
esac

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
if [[ -L "$REPO_ROOT/node_modules" || ! -d "$REPO_ROOT/node_modules" ]]; then
  echo 'FULL_FALLBACK_TEST_REFUSED: owned node_modules directory required' >&2
  exit 1
fi
CACHE_ROOT="$REPO_ROOT/node_modules/.cache/graph-full-suite"
RUNS_DIR="$CACHE_ROOT/runs"
mkdir -p "$RUNS_DIR" "$CACHE_ROOT/pip-cache"
chmod 700 "$CACHE_ROOT" "$RUNS_DIR" "$CACHE_ROOT/pip-cache"
PRIVATE_TMP=$(mktemp -d "$RUNS_DIR/run.XXXXXXXX")
chmod 700 "$PRIVATE_TMP"
mkdir -m 700 "$PRIVATE_TMP/home"
# The private exec/home dir must NOT live under /tmp or any other world-writable directory:
# deploy/prime-first-install.py protected() rejects every path chain with a group/other-writable
# component, so a HOME below /tmp makes test_prime_first_install.py fail with Refusal(custody)
# for a reason that has nothing to do with the code under test. Preserve execution reports in
# PRIVATE_TMP after the run.
#
# AF_UNIX path budget (unit '.'). The exec dir becomes TMPDIR of graph_full_suite.py, which adds its
# own mc-full-<unit>-XXXXXXXX scratch dir, and the deepest socket a maintained root test binds is
#   <exec dir>/mc-full-.-XXXXXXXX/bench-composition-XXXXXX/custody.sock
# (src/bench-reservation/composition.spec.ts; src/bench-reservation/composition.ts requires < 108
# bytes). On a CI runner XDG_RUNTIME_DIR is unset and RUNNER_TEMP is too deep for that budget
# (/opt/arcanada-runners/<runner>/_work/_temp gave a 126-byte socket path and 15 failed tests),
# so the candidates are, in order: XDG_RUNTIME_DIR, $HOME/.mcgs, RUNNER_TEMP. The first existing
# candidate that passes the custody checks AND fits the budget is used; when none fits the wrapper
# refuses. A too-deep base is never used, because the socket tests would then fail for a reason
# that has nothing to do with the code under test.
EXEC_TEMPLATE='/mcgs.XXXXXXXX'
SCRATCH_SUFFIX="/mc-full-${1//\//-}-XXXXXXXX"
SOCKET_SUFFIX='/bench-composition-XXXXXX/custody.sock'
SOCKET_LIMIT=108

refuse() {
  echo "FULL_FALLBACK_TEST_REFUSED: $1" >&2
  exit 1
}

check_private_base() { # check_private_base <resolved base>; refuses, never skips
  case "$1" in
    /tmp|/tmp/*|/var/tmp|/var/tmp/*)
      refuse 'the private exec dir may not live under /tmp or /var/tmp' ;;
  esac
  if [[ -L "$1" || ! -O "$1" ]] || (( 8#$(stat -c '%a' -- "$1") & 8#022 )); then
    refuse 'the private exec base must be owned by the caller and not group/other-writable'
  fi
}

fits_socket_budget() { # fits_socket_budget <exec dir or base + template>
  [[ "$UNIT" == . ]] || return 0  # only unit '.' binds AF_UNIX sockets below TMPDIR
  (( ${#1} + ${#SCRATCH_SUFFIX} + ${#SOCKET_SUFFIX} < SOCKET_LIMIT ))
}

home_base() { # home_base -> prints $HOME/.mcgs (created 0700 if missing); refuses a foreign one
  local base="$HOME/.mcgs"
  if [[ ! -e "$base" && ! -L "$base" ]]; then
    mkdir -m 700 -- "$base" 2>/dev/null || [[ -d "$base" && ! -L "$base" ]] \
      || refuse '$HOME/.mcgs could not be created'
  fi
  if [[ -L "$base" || ! -d "$base" || ! -O "$base" ]] || [[ "$(stat -c '%a' -- "$base")" != 700 ]]; then
    refuse '$HOME/.mcgs must be a directory owned by the caller with mode 0700, not a symlink'
  fi
  printf '%s\n' "$base"
}

UNIT=$1
EXEC_BASE=
seen=0
for source in xdg home runner; do
  candidate=
  case "$source" in
    xdg) candidate=${XDG_RUNTIME_DIR:-} ;;
    home) if [[ -n "${HOME:-}" && -d "$HOME" && ! -L "$HOME" && -O "$HOME" ]]; then candidate=$(home_base) || exit 1; fi ;;
    runner) candidate=${RUNNER_TEMP:-} ;;
  esac
  [[ -n "$candidate" && -d "$candidate" ]] || continue
  seen=1
  candidate=$(cd -- "$candidate" && pwd -P)
  check_private_base "$candidate"
  if fits_socket_budget "$candidate$EXEC_TEMPLATE"; then
    EXEC_BASE=$candidate
    break
  fi
done
if [[ -z "$EXEC_BASE" ]]; then
  if (( seen )); then
    refuse "no private exec base fits the ${SOCKET_LIMIT}-byte AF_UNIX path budget (tried XDG_RUNTIME_DIR, \$HOME/.mcgs, RUNNER_TEMP)"
  fi
  refuse 'set XDG_RUNTIME_DIR or RUNNER_TEMP to a private directory (the private exec dir may not live under /tmp)'
fi
EXEC_TMP=$(mktemp -d "$EXEC_BASE/mcgs.XXXXXXXX")
chmod 700 "$EXEC_TMP"
trap 'rm -rf -- "$EXEC_TMP"' EXIT
fits_socket_budget "$EXEC_TMP" || refuse "exec dir $EXEC_TMP exceeds the AF_UNIX path budget"

SYSTEM_PATH=$PATH
SYSTEM_PYTHON=$(PATH="$SYSTEM_PATH" command -v python3)
PYTHON_PATH=$SYSTEM_PATH
if [[ "$1" == 'packages/sdk-python' ]] && ! env -i PATH="$SYSTEM_PATH" "$SYSTEM_PYTHON" -c 'import pytest, pytest_asyncio' >/dev/null 2>&1; then
  VENV="$PRIVATE_TMP/python-sdk"
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" PIP_CACHE_DIR="$CACHE_ROOT/pip-cache" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$SYSTEM_PYTHON" -m venv "$VENV"
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" PIP_CACHE_DIR="$CACHE_ROOT/pip-cache" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$VENV/bin/python" -m pip install -e "$REPO_ROOT/packages/sdk-python[dev]"
  PYTHON_PATH="$VENV/bin:$SYSTEM_PATH"
fi

# Root Vitest/integration arms import @prisma/client. A clean install with
# ignored build scripts leaves the client ungenerated; generate into the owned
# node_modules before measurement when prisma is present (dummy URL — generate
# does not connect). Fixture harnesses without prisma skip this step.
if [[ "$1" == '.' && -x "$REPO_ROOT/node_modules/.bin/prisma" ]]; then
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$PYTHON_PATH" CI=1 \
    PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1 FORCE_COLOR=0 \
    DATABASE_URL='postgresql://prisma-generate:prisma-generate@127.0.0.1:5432/prisma_generate' \
    bash -lc "cd -- $(printf '%q' "$REPO_ROOT") && ./node_modules/.bin/prisma generate" \
    || { echo 'FULL_FALLBACK_TEST_REFUSED: prisma generate failed' >&2; exit 1; }
fi

set +e
env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$PYTHON_PATH" CI=1 PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1 FORCE_COLOR=0 bash "$SCRIPT_DIR/graph-full-suite.sh" "$1"
status=$?
shopt -s nullglob
for artifact in "$EXEC_TMP"/mc-full-*; do
  cp -a -- "$artifact" "$PRIVATE_TMP/"
done
exit "$status"
