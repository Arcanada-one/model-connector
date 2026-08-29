#!/usr/bin/env bats

# ARAS-0058 — the guard that keeps BILLING_ENFORCED declared must itself fail
# when the declaration is removed. A check nobody has watched fail is a check
# nobody knows works.
#
# Run: bats dev-tools/env-declaration-parity.spec.bats

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
  WORK="$(mktemp -d)"
  # A throwaway copy of exactly what the check reads, so mutating it cannot
  # touch the working tree.
  mkdir -p "${WORK}/dev-tools" "${WORK}/src"
  cp "${REPO_ROOT}/dev-tools/env-declaration-parity.sh" "${WORK}/dev-tools/"
  cp "${REPO_ROOT}/.env.example" "${WORK}/.env.example"
  cp "${REPO_ROOT}/src/config/env.schema.ts" "${WORK}/src/env.schema.ts"
}

teardown() {
  rm -rf "${WORK}"
}

@test "passes on the repository as it stands" {
  run bash "${REPO_ROOT}/dev-tools/env-declaration-parity.sh"
  [ "$status" -eq 0 ]
}

@test "fails when BILLING_ENFORCED is dropped from .env.example" {
  grep -v '^BILLING_ENFORCED=' "${WORK}/.env.example" > "${WORK}/.env.example.tmp"
  mv "${WORK}/.env.example.tmp" "${WORK}/.env.example"

  run bash "${WORK}/dev-tools/env-declaration-parity.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"BILLING_ENFORCED is not declared"* ]]
}

@test "fails when a declared var is read nowhere in src/" {
  # Dead config gets tidied away by the next person, which re-opens the gap.
  echo 'BILLING_MADE_UP_FLAG=false' >> "${WORK}/.env.example"
  sed -i 's/^    BILLING_ENFORCED$/    BILLING_ENFORCED\n    BILLING_MADE_UP_FLAG/' \
    "${WORK}/dev-tools/env-declaration-parity.sh"

  run bash "${WORK}/dev-tools/env-declaration-parity.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"read nowhere in src/"* ]]
}
