#!/usr/bin/env bash
# CONN-0230: install a SELF-CONTAINED watcher release to /opt and symlink `current`.
#
# SOURCE_DIR MUST be a self-contained bundle produced by:
#   pnpm --filter @arcanada/model-connector-watcher deploy --legacy --prod <SOURCE_DIR>
# which materialises BOTH dist/ AND a self-contained node_modules/ (its own .pnpm
# store, no `../../` symlinks). Copying only dist/ is insufficient — the runtime
# imports pino/zod/yaml and pnpm's workspace node_modules are symlinks into the
# repo-root store that do not exist under /opt.
#
# Service enable/start and token provisioning remain operator-gated.
set -euo pipefail
IFS=$'\n\t'

readonly source_dir="${1:-}"
readonly release_dir="${2:-}"

if [[ -z "$source_dir" || -z "$release_dir" ]]; then
  echo "Usage: install-local.sh SOURCE_DIR RELEASE_DIR" >&2
  echo "  SOURCE_DIR must be a 'pnpm deploy --legacy --prod' bundle (dist/ + node_modules/)" >&2
  exit 2
fi
if [[ "$source_dir" != /* || "$release_dir" != /opt/model-connector-watcher/releases/* ]]; then
  echo "Absolute source and versioned /opt release paths are required" >&2
  exit 2
fi
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root on the operator-approved target host" >&2
  exit 1
fi

# The bundle must be self-contained: dist/ + node_modules/ both present.
if [[ ! -f "$source_dir/dist/src/main.js" ]]; then
  echo "SOURCE_DIR missing dist/src/main.js — did you run 'pnpm deploy --legacy --prod'?" >&2
  exit 3
fi
if [[ ! -d "$source_dir/node_modules" ]]; then
  echo "SOURCE_DIR missing node_modules/ — copy a 'pnpm deploy' bundle, not the raw repo (dist-only is insufficient)" >&2
  exit 3
fi

id model-connector-watcher >/dev/null 2>&1 ||
  useradd --system --home /var/lib/model-connector-watcher --shell /usr/sbin/nologin model-connector-watcher
install -d -m 0700 -o model-connector-watcher -g model-connector-watcher /var/lib/model-connector-watcher
install -d -m 0755 "$release_dir"

# Copy the self-contained bundle: dist + node_modules (+ package.json if present).
cp -a -- "$source_dir/dist" "$release_dir/"
cp -a -- "$source_dir/node_modules" "$release_dir/"
[[ -f "$source_dir/package.json" ]] && cp -a -- "$source_dir/package.json" "$release_dir/"

ln -sfn -- "$release_dir" /opt/model-connector-watcher/current

# Verify the installed release loads its runtime deps standalone (fail loud if not).
if ! ( cd "$release_dir" && node -e "require('pino');require('zod');require('yaml')" ) 2>/dev/null; then
  echo "Installed release failed standalone dep load (pino/zod/yaml) — bundle is incomplete" >&2
  exit 4
fi

echo "Installed self-contained release at $release_dir (current -> $release_dir)."
echo "Service enable/start and token provisioning remain operator-gated."
