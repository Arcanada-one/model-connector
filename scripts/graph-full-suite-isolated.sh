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

base_problem() { # base_problem <resolved base>; prints why it is not a private exec base, or nothing
  case "$1" in
    /tmp|/tmp/*|/var/tmp|/var/tmp/*)
      echo 'it lives under /tmp or /var/tmp'; return ;;
  esac
  if [[ -L "$1" || ! -O "$1" ]] || (( 8#$(stat -c '%a' -- "$1") & 8#022 )); then
    echo 'it is a symlink, not owned by the caller, or group/other-writable'
  fi
}

fits_socket_budget() { # fits_socket_budget <exec dir or base + template>
  [[ "$UNIT" == . ]] || return 0  # only unit '.' binds AF_UNIX sockets below TMPDIR
  (( ${#1} + ${#SCRATCH_SUFFIX} + ${#SOCKET_SUFFIX} < SOCKET_LIMIT ))
}

home_candidate() { # sets CANDIDATE to $HOME/.mcgs (created 0700 if missing), or WHY to the reason it is skipped
  local base="${HOME:-}/.mcgs"
  if [[ -z "${HOME:-}" || ! -d "$HOME" || -L "$HOME" || ! -O "$HOME" ]]; then
    WHY='HOME is unset, not a directory, a symlink or not owned by the caller'; return
  fi
  if (( 8#$(stat -c '%a' -- "$HOME") & 8#022 )); then
    WHY='HOME is group/other-writable'; return
  fi
  if [[ ! -e "$base" && ! -L "$base" ]]; then
    if ! mkdir -m 700 -- "$base" 2>/dev/null && ! [[ -d "$base" && ! -L "$base" ]]; then
      WHY='$HOME/.mcgs could not be created'; return
    fi
  fi
  if [[ -L "$base" || ! -d "$base" || ! -O "$base" ]] || [[ "$(stat -c '%a' -- "$base")" != 700 ]]; then
    WHY='$HOME/.mcgs is a symlink or not a caller-owned 0700 directory'; return
  fi
  CANDIDATE=$base
}

# Every candidate is checked for custody AND (unit '.') the socket budget. A candidate that fails either
# is skipped with its reason on stderr; the run refuses only when no candidate passes both, so the base
# that is used has always passed every custody check.
UNIT=$1
EXEC_BASE=
for source in XDG_RUNTIME_DIR '$HOME/.mcgs' RUNNER_TEMP; do
  CANDIDATE= WHY=
  case "$source" in
    XDG_RUNTIME_DIR) CANDIDATE=${XDG_RUNTIME_DIR:-} ;;
    '$HOME/.mcgs') home_candidate ;;
    RUNNER_TEMP) CANDIDATE=${RUNNER_TEMP:-} ;;
  esac
  if [[ -z "$WHY" && -z "$CANDIDATE" ]]; then
    WHY='not set'
  elif [[ -z "$WHY" && ! -d "$CANDIDATE" ]]; then
    WHY='not a directory'
  fi
  if [[ -z "$WHY" ]]; then
    CANDIDATE=$(cd -- "$CANDIDATE" && pwd -P)
    WHY=$(base_problem "$CANDIDATE")
  fi
  if [[ -z "$WHY" ]] && ! fits_socket_budget "$CANDIDATE$EXEC_TEMPLATE"; then
    WHY="too deep for the ${SOCKET_LIMIT}-byte AF_UNIX path budget"
  fi
  if [[ -z "$WHY" ]]; then
    EXEC_BASE=$CANDIDATE
    echo "graph-full-suite-isolated: exec base from $source" >&2
    break
  fi
  echo "graph-full-suite-isolated: skipped exec base candidate $source: $WHY" >&2
done
if [[ -z "$EXEC_BASE" ]]; then
  refuse "no private exec base passes custody and the ${SOCKET_LIMIT}-byte AF_UNIX path budget (tried XDG_RUNTIME_DIR, \$HOME/.mcgs, RUNNER_TEMP; the private exec dir may not live under /tmp)"
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

# Root regressions of unit '.' include .github/graph-admission/tools/graph/test_source_input_contract.py,
# which imports jsonschema. The system /usr/bin/python3 on the CI runners has none, and the setup-python
# interpreter of the workflow is deliberately not on this PATH. Build a private venv from the system
# python (no system site-packages) and install the hash-locked set with --require-hashes --no-deps
# --only-binary=:all: and pip --isolated (no pip.conf or PIP_* environment). Any failure refuses;
# the regression is never skipped.
REGRESSION_LOCK="$SCRIPT_DIR/graph-full-suite-regression.requirements.txt"
if [[ "$1" == '.' ]]; then
  REG_VENV="$PRIVATE_TMP/regression-python"
  reg_env=(env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" PYTHONDONTWRITEBYTECODE=1)
  [[ -f "$REGRESSION_LOCK" && ! -L "$REGRESSION_LOCK" ]] || refuse 'regression lock file missing'
  # Optional offline source (tests, air-gapped hosts): GRAPH_FULL_SUITE_WHEELHOUSE names a local directory
  # used with --no-index --find-links. It changes only where the wheels come from; --require-hashes still
  # admits nothing but the exact sha256 bytes pinned in the lock.
  pip_source=()
  if [[ -n "${GRAPH_FULL_SUITE_WHEELHOUSE:-}" ]]; then
    [[ -d "$GRAPH_FULL_SUITE_WHEELHOUSE" && ! -L "$GRAPH_FULL_SUITE_WHEELHOUSE" ]] \
      || refuse 'GRAPH_FULL_SUITE_WHEELHOUSE must be a directory, not a symlink'
    pip_source=(--no-index --find-links "$GRAPH_FULL_SUITE_WHEELHOUSE")
  fi
  "${reg_env[@]}" "$SYSTEM_PYTHON" -I -m venv "$REG_VENV" \
    || refuse 'regression venv could not be created from the system python'
  "${reg_env[@]}" "$REG_VENV/bin/python" -I -m pip --isolated --disable-pip-version-check --no-input \
    install --cache-dir "$CACHE_ROOT/pip-cache" --require-hashes --no-deps --only-binary=:all: \
    "${pip_source[@]}" -r "$REGRESSION_LOCK" \
    || refuse 'hash-locked regression dependencies could not be installed'
  "${reg_env[@]}" "$REG_VENV/bin/python" -I -c '
import sys, jsonschema, importlib.metadata as md
venv = sys.argv[1]
assert jsonschema.__file__.startswith(venv + "/"), jsonschema.__file__
assert md.version("jsonschema") == "4.23.0", md.version("jsonschema")
' "$REG_VENV" || refuse 'regression venv does not provide the locked jsonschema'
  PYTHON_PATH="$REG_VENV/bin:$PYTHON_PATH"
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
