#!/usr/bin/env bats
#
# CONN-0228 — enforcement for the consumer-scoped public-surface regex override.
#
# Verifies that the tightened milestone pattern:
#   1. does NOT false-positive on the public model name `BGE-M3` (the bug),
#   2. STILL flags genuine milestone-code leaks (`M1`, `Phase 2`, `level M3`),
#   3. leaves the repo's own public surface clean under the override.
#
# This is the real enforcement the framework default lacked: a fixture that
# would go red if the override pattern regressed back to the loose boundary.
# Run: bats dev-tools/public-surface-forbidden.regex.spec.bats

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  REGEX="$REPO_ROOT/dev-tools/public-surface-forbidden.regex"
  # Extract only the active (non-comment, non-blank) milestone line.
  MILESTONE_PATTERN="$(grep -E '\(M\|Phase\)' "$REGEX" | grep -v '^#')"
}

@test "override regex file exists and has active patterns" {
  [ -f "$REGEX" ]
  run grep -cvE '^[[:space:]]*(#.*)?$' "$REGEX"
  [ "$status" -eq 0 ]
  [ "$output" -ge 6 ]
}

@test "milestone pattern does NOT match BGE-M3 (the CONN-0228 false positive)" {
  run grep -E "$MILESTONE_PATTERN" <<< "Embedding via BGE-M3 self-hosted"
  [ "$status" -ne 0 ]
}

@test "milestone pattern does NOT match other hyphenated identifiers" {
  run grep -E "$MILESTONE_PATTERN" <<< "model LLaMA-M2 and foo-M9-bar"
  [ "$status" -ne 0 ]
}

@test "milestone pattern STILL flags standalone milestone leaks" {
  run grep -E "$MILESTONE_PATTERN" <<< "shipped in M1"
  [ "$status" -eq 0 ]
  run grep -E "$MILESTONE_PATTERN" <<< "Phase 2 internal rollout"
  [ "$status" -eq 0 ]
  run grep -E "$MILESTONE_PATTERN" <<< "reached level M3 of the plan"
  [ "$status" -eq 0 ]
}

@test "repo public surface is clean under the override regex" {
  # Self-contained check: grep each active pattern from the override over the
  # public surface and expect zero hits. Mirrors what the CI linter does, but
  # without depending on the framework script being checked out locally.
  cd "$REPO_ROOT"
  hits=0
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue ;; esac
    if grep -rEn --include='*.md' --exclude-dir=node_modules -e "$pat" \
         README.md CHANGELOG.md docs packages >/dev/null 2>&1; then
      echo "forbidden pattern matched: $pat" >&2
      hits=$((hits + 1))
    fi
  done < "$REGEX"
  [ "$hits" -eq 0 ]
}
