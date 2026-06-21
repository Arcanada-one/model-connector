#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

readonly source_dir="${1:-}"
readonly release_dir="${2:-}"

if [[ -z "$source_dir" || -z "$release_dir" ]]; then
  echo "Usage: install-local.sh SOURCE_DIR RELEASE_DIR" >&2
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

id model-connector-watcher >/dev/null 2>&1 ||
  useradd --system --home /var/lib/model-connector-watcher --shell /usr/sbin/nologin model-connector-watcher
install -d -m 0700 -o model-connector-watcher -g model-connector-watcher /var/lib/model-connector-watcher
install -d -m 0755 "$release_dir"
cp -a -- "$source_dir/dist" "$release_dir/"
ln -sfn -- "$release_dir" /opt/model-connector-watcher/current

echo "Installed files only. Service enable/start and token provisioning remain operator-gated."
