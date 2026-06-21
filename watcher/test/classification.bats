#!/usr/bin/env bats

setup() {
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  CLI="$BATS_TEST_DIRNAME/../dist/src/main.js"
}

assert_class() {
  local fixture="$1"
  local expected="$2"
  run node "$CLI" --once --fixture "$BATS_TEST_DIRNAME/fixtures/$fixture.json"
  [ "$status" -eq 0 ] && echo "$output" | grep -qF "\"failureClass\":\"$expected\""
}

@test "provider outage fixture" { assert_class provider-outage provider_outage; }
@test "rate quota fixture" { assert_class rate-quota rate_or_quota; }
@test "authentication fixture" { assert_class authentication authentication; }
@test "billing fixture" { assert_class billing billing; }
@test "circuit open fixture" { assert_class circuit-open circuit_open; }
@test "unknown fixture" { assert_class unknown unknown; }
