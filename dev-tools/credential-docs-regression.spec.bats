#!/usr/bin/env bats

# CONN-0305 — public documentation must use obvious credential placeholders.
# Run: bats dev-tools/credential-docs-regression.spec.bats

@test "README has no realistic Model Connector example key" {
  run bash "${BATS_TEST_DIRNAME}/credential-docs-regression.sh" model-key
  [ "$status" -eq 0 ]
}

@test "README has no PostgreSQL URI with an inline password" {
  run bash "${BATS_TEST_DIRNAME}/credential-docs-regression.sh" postgres-uri
  [ "$status" -eq 0 ]
}

@test "public docs use explicit credential placeholders" {
  run bash "${BATS_TEST_DIRNAME}/credential-docs-regression.sh" placeholders
  [ "$status" -eq 0 ]
}

@test "README keeps credentials out of process arguments" {
  run bash "${BATS_TEST_DIRNAME}/credential-docs-regression.sh" safe-usage
  [ "$status" -eq 0 ]
}
