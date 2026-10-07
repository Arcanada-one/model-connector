#!/usr/bin/env bash
# Ordinary source runner; this declaration is not its own admission or grant.
set -euo pipefail
if [[ $# != 1 || -L ${BASH_SOURCE[0]} ]]; then
  echo 'FULL_FALLBACK_TEST_REFUSED: invalid entrypoint' >&2
  exit 1
fi
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 -B "$SCRIPT_DIR/graph_full_suite.py" "$1"
