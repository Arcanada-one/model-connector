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
PRIVATE_TMP=$(mktemp -d /tmp/model-connector-full-suite.XXXXXXXX)
cleanup() {
  rm -rf -- "$PRIVATE_TMP"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$PRIVATE_TMP"
mkdir -m 700 "$PRIVATE_TMP/home"

SYSTEM_PATH=$PATH
SYSTEM_PYTHON=$(PATH="$SYSTEM_PATH" command -v python3)
PYTHON_PATH=$SYSTEM_PATH
if [[ "$1" == 'packages/sdk-python' ]] && ! env -i PATH="$SYSTEM_PATH" "$SYSTEM_PYTHON" -c 'import pytest, pytest_asyncio' >/dev/null 2>&1; then
  VENV="$PRIVATE_TMP/python-sdk"
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$PRIVATE_TMP" PATH="$SYSTEM_PATH" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$SYSTEM_PYTHON" -m venv "$VENV"
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$PRIVATE_TMP" PATH="$SYSTEM_PATH" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$VENV/bin/python" -m pip install -e "$REPO_ROOT/packages/sdk-python[dev]"
  PYTHON_PATH="$VENV/bin:$SYSTEM_PATH"
fi

set +e
env -i HOME="$PRIVATE_TMP/home" TMPDIR="$PRIVATE_TMP" PATH="$PYTHON_PATH" CI=1 PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1 FORCE_COLOR=0 bash "$SCRIPT_DIR/graph-full-suite.sh" "$1"
status=$?
exit "$status"
