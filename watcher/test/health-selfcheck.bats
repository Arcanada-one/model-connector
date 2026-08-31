#!/usr/bin/env bats
# CONN-0230 / INFRA-0462 — specs for the watcher health self-check.
#
# The defect these exist to prevent: NRestarts is a lifetime counter, so a fixed
# ceiling produces an alarm that can never clear. The unit had run untouched for
# ten days while the check reported a restart loop four times a day. There was no
# coverage at all before this file, which is why a one-line comparison survived
# review and then ran unquestioned for two months.
#
# The script shells out to systemctl, curl and node. Rather than mock the world,
# the specs put stubs first on PATH and let the real control flow run. The
# verdict is read from the script's own log, which is the record the operator
# reads too -- asserting on it means the specs and the operator see the same
# thing.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../deploy/health-selfcheck.sh"
  WORK="$(mktemp -d)"
  STUBS="$WORK/bin"
  mkdir -p "$STUBS"

  export SELFCHECK_STATE="$WORK/selfcheck-state"
  export SELFCHECK_UNIT="fixture-watcher.service"
  export SELFCHECK_LOG="$WORK/selfcheck.log"
  export PATH="$STUBS:$PATH"

  # curl: report a healthy endpoint unless a test overrides the code. The Ops Bot
  # POST never happens here because the env file does not exist in the sandbox,
  # so an alarm is observable in the log and nowhere else -- which is what we
  # want to assert on.
  cat > "$STUBS/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s' "${STUB_CURL_CODE:-200}"
exit 0
EOF

  # node: the analyzer is informational for this check.
  cat > "$STUBS/node" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  chmod +x "$STUBS/curl" "$STUBS/node"
  stub_systemctl active 0
}

teardown() {
  rm -rf "$WORK"
}

# $1 = is-active answer, $2 = NRestarts value
stub_systemctl() {
  cat > "$STUBS/systemctl" <<EOF
#!/usr/bin/env bash
case "\$1" in
  is-active) printf '%s\n' '$1'; exit 0 ;;
  show)      printf '%s\n' '$2'; exit 0 ;;
esac
exit 0
EOF
  chmod +x "$STUBS/systemctl"
}

@test "a unit that has not restarted since the last check is silent" {
  stub_systemctl active 4
  printf 'nrestarts=4\ncheckedAt=2026-08-31T00:00:00Z\n' > "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  # The exact regression this pins: NRestarts=4 against the old `-gt 3` ceiling
  # alerted forever. Four lifetime restarts and zero recent ones is now quiet.
  run grep -c 'restart loop' "$SELFCHECK_LOG"
  [ "$output" -eq 0 ]
  grep -q 'OK ' "$SELFCHECK_LOG"
}

@test "the lifetime counter alone never raises an alarm" {
  # No previous reading: a lifetime counter says nothing about the window that
  # just passed, so the first run records and stays quiet. Treating an unknown
  # baseline as zero would resurrect exactly the false alarm this replaces.
  stub_systemctl active 4000
  rm -f "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  run grep -c 'restart loop' "$SELFCHECK_LOG"
  [ "$output" -eq 0 ]
  grep -qx 'nrestarts=4000' "$SELFCHECK_STATE"
}

@test "more than three restarts inside one window is still a loop" {
  stub_systemctl active 9
  printf 'nrestarts=4\n' > "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  # Five restarts since the last look. Softening the cumulative comparison must
  # not soften the detection it exists for -- without this arm the fix could be
  # "never alarm", which passes the other tests and protects nothing.
  grep -q 'restart loop: 5 restarts since last check' "$SELFCHECK_LOG"
  grep -qx 'nrestarts=9' "$SELFCHECK_STATE"
}

@test "exactly three restarts in a window stays under the threshold" {
  stub_systemctl active 3
  printf 'nrestarts=0\n' > "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  run grep -c 'restart loop' "$SELFCHECK_LOG"
  [ "$output" -eq 0 ]
}

@test "the reading is recorded on every run, alarm or not" {
  stub_systemctl active 12
  printf 'nrestarts=2\n' > "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  # Without this the window never advances and one bad run alarms forever --
  # the same never-clearing shape in a new place.
  grep -qx 'nrestarts=12' "$SELFCHECK_STATE"
}

@test "a counter that went backwards is a fresh baseline, not a negative rate" {
  # Unit reinstalled: NRestarts resumes from a lower number. Arithmetic on that
  # yields a negative delta, which must not be read as a rate.
  stub_systemctl active 1
  printf 'nrestarts=40\n' > "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  run grep -c 'restart loop' "$SELFCHECK_LOG"
  [ "$output" -eq 0 ]
  grep -qx 'nrestarts=1' "$SELFCHECK_STATE"
}

@test "a non-numeric counter does not crash the check" {
  # systemctl absent, or the property unsupported: the arithmetic must not abort
  # the run, or the other four probes are lost along with it.
  stub_systemctl active ""
  rm -f "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx 'nrestarts=0' "$SELFCHECK_STATE"
}

@test "an inactive service is still reported" {
  stub_systemctl failed 0
  printf 'nrestarts=0\n' > "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  # Reworking the restart check must not disturb the other probes.
  grep -q 'service not active: failed' "$SELFCHECK_LOG"
}

@test "a failing health endpoint is still reported" {
  STUB_CURL_CODE=503
  export STUB_CURL_CODE
  printf 'nrestarts=0\n' > "$SELFCHECK_STATE"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q 'health endpoint 503' "$SELFCHECK_LOG"
}

@test "the script is syntactically valid" {
  run bash -n "$SCRIPT"
  [ "$status" -eq 0 ]
}
