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
# Keep runtime-created Unix socket names below the platform's 108-byte limit.
# The verifier cache path is intentionally deep; using it as TMPDIR made the
# BENCH composition fixtures reject otherwise valid socket paths. A sibling of
# the checkout is still too long once graph_full_suite.py adds its own scratch
# directory and the fixtures add their socket names, so use a private short
# system-temp path. Preserve execution reports in PRIVATE_TMP after the run.
EXEC_TMP=$(mktemp -d /tmp/mcgs.XXXXXXXX)
chmod 700 "$EXEC_TMP"
trap 'rm -rf -- "$EXEC_TMP"' EXIT

SYSTEM_PATH=$PATH
SYSTEM_PYTHON=$(PATH="$SYSTEM_PATH" command -v python3)
PYTHON_PATH=$SYSTEM_PATH
if [[ "$1" == 'packages/sdk-python' ]] && ! env -i PATH="$SYSTEM_PATH" "$SYSTEM_PYTHON" -c 'import pytest, pytest_asyncio' >/dev/null 2>&1; then
  VENV="$PRIVATE_TMP/python-sdk"
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" PIP_CACHE_DIR="$CACHE_ROOT/pip-cache" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$SYSTEM_PYTHON" -m venv "$VENV"
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" PIP_CACHE_DIR="$CACHE_ROOT/pip-cache" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$VENV/bin/python" -m pip install -e "$REPO_ROOT/packages/sdk-python[dev]"
  PYTHON_PATH="$VENV/bin:$SYSTEM_PATH"
fi

set +e
env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$PYTHON_PATH" CI=1 PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1 FORCE_COLOR=0 bash "$SCRIPT_DIR/graph-full-suite.sh" "$1"
status=$?
shopt -s nullglob
for artifact in "$EXEC_TMP"/mc-full-*; do
  cp -a -- "$artifact" "$PRIVATE_TMP/"
done
exit "$status"
