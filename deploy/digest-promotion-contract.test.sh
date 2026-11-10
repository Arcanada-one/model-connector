#!/usr/bin/env bash
# Offline contract for the digest-promotion gap-fill workflows.
# Asserts publish-image / published-image.json / digest-identity guard exist
# without weakening the existing push-main broker deploy job.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ci="$root/.github/workflows/ci.yml"
deploy="$root/.github/workflows/deploy.yml"

test -f "$ci"
test -f "$deploy"

grep -Fq 'publish-image:' "$ci"
grep -Fq 'verify-published-image:' "$ci"
grep -Fq 'published-image.json' "$ci"
grep -Fq 'ghcr.io/arcanada-one/model-connector' "$ci"
grep -Fq 'model-connector-image-' "$ci"

# Existing production deploy path must remain push-main broker sync+run-deploy.
grep -Fq 'arcanada-compose-broker model-connector sync' "$ci"
grep -Fq 'arcanada-compose-broker model-connector run-deploy' "$ci"
grep -Fq 'group: deploy-model-connector' "$ci"
grep -Fq 'cancel-in-progress: false' "$ci"

# Digest workflow is identity-only (no production cutover verbs).
grep -Fq 'workflow_dispatch:' "$deploy"
grep -Fq 'image_digest:' "$deploy"
grep -Fq 'published-image.json' "$deploy"
grep -Fq 'publication-post-state:' "$deploy"
grep -Fq 'production_cutover=NOT_RUN' "$deploy"
if grep -Eq 'arcanada-compose-broker model-connector (sync|run-deploy)' "$deploy"; then
  echo 'FAIL: digest identity workflow must not invoke production broker cutover' >&2
  exit 1
fi

# published-image.json shape contract (Control/Support-compatible fields).
tmp="$(mktemp)"
jq -n --arg release "$(python3 -c 'print("a"*40)')" \
  --arg digest "sha256:$(python3 -c 'print("b"*64)')" \
  '{schema_version: 1, release_sha: $release, image_digest: $digest}' >"$tmp"
jq -e '
  .schema_version == 1 and
  (.release_sha | test("^[0-9a-f]{40}$")) and
  (.image_digest | test("^sha256:[0-9a-f]{64}$"))
' "$tmp" >/dev/null
rm -f "$tmp"

printf 'digest-promotion-contract: PASS\n'
