#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
subject="${script_dir}/arcanada-compose-broker.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "${fixture_dir}"' EXIT

state_root="${fixture_dir}/state"
env_root="${fixture_dir}/env"
bin_root="${fixture_dir}/bin"
broker="${fixture_dir}/broker"
mkdir -p "${state_root}/muneral/apps/api/scripts" "${env_root}" "${bin_root}"
cp "$subject" "$broker"

# A2-260 — a REAL HEAD, not an empty `.git` directory. muneral is now in the
# BUILDSHA table, so `compose_env` reads `git rev-parse HEAD` out of this
# checkout for every compose verb; a fixture that cannot answer would make
# every muneral case red for a reason that has nothing to do with what it
# asserts. `require_checkout` still sees the `.git` it looks for.
git -C "${state_root}/muneral" init -q
git -C "${state_root}/muneral" -c user.email=t@example.invalid -c user.name=t \
  commit -q --allow-empty -m 'fixture head'
muneral_head="$(git -C "${state_root}/muneral" rev-parse HEAD)"

helper="${state_root}/muneral/apps/api/scripts/semantic-aggregate-readback.mjs"
printf '%s\n' '// fixed reviewed helper fixture' >"$helper"
printf '%s\n' 'DATABASE_URL=postgresql://fixture-secret-must-not-print' >"${env_root}/muneral.env"

fake_node="${bin_root}/node"
cat >"$fake_node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]]
[[ "$1" == */state/muneral/apps/api/scripts/semantic-aggregate-readback.mjs ]]
[[ "${DATABASE_URL:-}" == 'postgresql://fixture-secret-must-not-print' ]]
echo 'MUNERAL_AGGREGATE_READBACK_V1 {"integrityOk":true}'
SH
chmod 0755 "$fake_node"

owner="$(id -un)"
sed -i \
  -e "s#^readonly STATE_ROOT=.*#readonly STATE_ROOT='${state_root}'#" \
  -e "s#^readonly ENV_ROOT=.*#readonly ENV_ROOT='${env_root}'#" \
  -e "s#^readonly NODE=.*#readonly NODE='${fake_node}'#" \
  -e "s#== 'root'#== '${owner}'#g" \
  `# install(1) can only set an owner as root, and the CI runner is not root.` \
  `# The harness already rewrites the root-ownership CHECK above for the same` \
  `# reason; this rewrites the ownership it ASSIGNS, so the placement cases can` \
  `# run unprivileged. Mode is left alone — 0600 needs no privilege.` \
  -e "s#install -m 0600 -o root -g root#install -m 0600 -o ${owner} -g $(id -gn)#" \
  "$broker"
chmod 0755 "$broker"

expect_pass() {
  local name="$1"; shift
  if ! "$broker" "$@" >"${fixture_dir}/${name}.out" 2>&1; then
    echo "FAIL: ${name} unexpectedly failed" >&2
    sed -n '1,80p' "${fixture_dir}/${name}.out" >&2
    exit 1
  fi
  if grep -Fq 'fixture-secret-must-not-print' "${fixture_dir}/${name}.out"; then
    echo "FAIL: ${name} leaked connection material" >&2
    exit 1
  fi
  echo "PASS: ${name}"
}

expect_fail() {
  local name="$1"; shift
  if "$broker" "$@" >"${fixture_dir}/${name}.out" 2>&1; then
    echo "FAIL: ${name} unexpectedly passed" >&2
    exit 1
  fi
  echo "PASS: ${name}"
}

# `expect_fail` is satisfied by ANY non-zero exit, so on its own it cannot tell
# "refused for the stated reason" from "died later for an unrelated one" -- and
# under `set -e` a bare `grep` assertion that misses ends the run with no
# output at all, which reads like a crash rather than a red test. This names
# what was expected and where to look.
expect_message() {
  local name="$1" needle="$2" file="${fixture_dir}/${1}.out"
  if ! grep -Fq -- "$needle" "$file"; then
    echo "FAIL: ${name}: expected message not found: ${needle}" >&2
    sed -n '1,80p' "$file" >&2
    exit 1
  fi
}

expect_pass fixed_muneral_readback muneral aggregate-readback
grep -Fq 'MUNERAL_AGGREGATE_READBACK_V1' "${fixture_dir}/fixed_muneral_readback.out"

expect_fail caller_argument_rejected muneral aggregate-readback SELECT-1
expect_fail other_service_rejected model-connector aggregate-readback

mv "$helper" "${helper}.real"
ln -s "${helper}.real" "$helper"
expect_fail symlinked_helper_rejected muneral aggregate-readback
rm -f "$helper"
mv "${helper}.real" "$helper"

mv "${env_root}/muneral.env" "${env_root}/muneral.env.saved"
expect_fail missing_root_environment_rejected muneral aggregate-readback
mv "${env_root}/muneral.env.saved" "${env_root}/muneral.env"

mv "${env_root}/muneral.env" "${env_root}/muneral.env.real"
ln -s "${env_root}/muneral.env.real" "${env_root}/muneral.env"
expect_fail symlinked_environment_rejected muneral aggregate-readback
rm -f "${env_root}/muneral.env"
mv "${env_root}/muneral.env.real" "${env_root}/muneral.env"

cp "$broker" "${broker}.owner-check"
sed -i "s/== '${owner}'/== 'definitely-not-${owner}'/g" "$broker"
expect_fail non_root_owned_environment_rejected muneral aggregate-readback
mv "${broker}.owner-check" "$broker"

# INFRA-0417 — the ephemeral registry credential (`registry-login`) is a host
# capability, not a per-service one: once established, root's docker config is
# authenticated for anything that pulls. The service argument is therefore the
# only thing keeping "may be deployed by the broker" from silently also meaning
# "may place a credential on the host", so it is worth a test of its own.
#
# muneral is in the deploy allowlist and NOT in REGISTRY_AUTH, so it stands in
# for every service that must be refused. These cases assert the refusal, not
# the login itself: a passing login would need a real registry and a real
# token, which no unit test should have.
expect_fail registry_login_refused_for_unlisted_service \
  muneral registry-login Arcanada
expect_fail registry_logout_refused_for_unlisted_service \
  muneral registry-logout
grep -Fq 'may not establish a registry credential' \
  "${fixture_dir}/registry_login_refused_for_unlisted_service.out"
grep -Fq 'may not clear a registry credential' \
  "${fixture_dir}/registry_logout_refused_for_unlisted_service.out"

# A service outside the deploy allowlist entirely must be rejected earlier
# still, by validate_service, before the registry table is ever consulted.
expect_fail registry_login_refused_for_unknown_service \
  not-a-service registry-login Arcanada

# The username is interpolated into a `docker login` argv, so it must not be
# able to smuggle a flag. `verdicus` IS in REGISTRY_AUTH, which is what makes
# this case reach the username check rather than stopping at the table.
expect_fail registry_login_rejects_flag_username \
  verdicus registry-login --insecure
grep -Fq 'implausible registry username' \
  "${fixture_dir}/registry_login_rejects_flag_username.out"

# Arity is part of the contract: a missing username must not fall through to a
# login with an empty user, and an extra argument must not be ignored.
expect_fail registry_login_requires_a_username verdicus registry-login
expect_fail registry_logout_takes_no_arguments verdicus registry-logout extra

# INFRA-0417 — IMAGE_TAG must come from the broker's OWN checkout.
#
# verdicus pulls a pre-built image whose tag IS the entire identity of what
# gets deployed. `${IMAGE_TAG:-latest}` in the compose file means an unset
# variable does not fail — it silently resolves to a floating tag, and the
# deploy stops being pinned to the commit that triggered it. That is a bug that
# reports success, so it needs a test that reads the value rather than the exit
# code.
verdicus_checkout="${state_root}/verdicus"
mkdir -p "$verdicus_checkout"
git -C "$verdicus_checkout" init -q
git -C "$verdicus_checkout" -c user.email=t@example.invalid -c user.name=t \
  commit -q --allow-empty -m 'fixture head'
verdicus_head="$(git -C "$verdicus_checkout" rev-parse HEAD)"
printf '%s\n' 'IMAGE_TAG_FIXTURE=1' >"${env_root}/verdicus.env"
printf '%s\n' 'services: {}' >"${verdicus_checkout}/docker-compose.prod.yml"

# muneral is exercised for the negative case below and needs a compose file of
# its own for the same reason.
printf '%s\n' 'services: {}' >"${state_root}/muneral/docker-compose.prod.yml"

fake_docker="${bin_root}/docker"
fake_docker_state="${fixture_dir}/docker-state"
fake_docker_log="${fixture_dir}/docker.log"
fake_curl_log="${fixture_dir}/curl.log"
mkdir -p "$fake_docker_state"
: >"$fake_docker_log"
: >"$fake_curl_log"
export FAKE_DOCKER_STATE="$fake_docker_state" FAKE_DOCKER_LOG="$fake_docker_log"
export FAKE_CURL_LOG="$fake_curl_log"
cat >"$fake_docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
ref_id() {
  case "$1" in
    scrutator-deploy:16a4061f0493fef5fc159e252cd793185ec2283c)
      printf '%s' "${FAKE_KC_IMAGE_ID:-sha256:ae4a4768ce83f34b3dc7c5b1620f836b8eafef86e32687b43a5c6a4eaa0c0c85}"; return 0 ;;
    scrutator-deploy:cc1e9828a89444c752faefec8fa39236d181465d)
      printf '%s' 'sha256:9adb3252b20ddd5508f42fcb56fc2c28512b047d192cb545e40f31a5869e3b26'; return 0 ;;
    *:latest) tag=latest ;;
    *:previous) tag=previous ;;
    muneral-api:*)
      tag="release-${1#muneral-api:}"
      [[ "${1#muneral-api:}" =~ ^[0-9a-f]{40}$ ]] || return 1
      ;;
    *) [[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]] && { printf '%s' "$1"; return 0; } || return 1 ;;
  esac
  [[ -s "$FAKE_DOCKER_STATE/$tag" ]] || return 1
  cat "$FAKE_DOCKER_STATE/$tag"
}
if [[ "${1:-}" == image && "${2:-}" == inspect ]]; then
  id="$(ref_id "${3:-}")" || exit 1
  printf '%s\n' "$id"
  exit 0
fi
if [[ "${1:-}" == container && "${2:-}" == inspect ]]; then
  if [[ "${3:-}" == knowledge-contract-scrutator-scrutator-1 && -e "$FAKE_DOCKER_STATE/kc-exists" ]]; then
    exit 0
  fi
  exit 1
fi
if [[ "${1:-}" == logs && "${2:-}" == --tail && "${3:-}" == 200 &&
      "${4:-}" == knowledge-contract-scrutator-scrutator-1 ]]; then
  if [[ "${FAKE_KC_HANG_LOGS:-}" == 1 ]]; then sleep 20; fi
  printf 'startup diagnostic fixture\npostgresql://kc_scrutator_app:synthetic-secret@db/knowledge_contract\n'
  exit 0
fi
if [[ "${1:-}" == ps && " $* " == *' label=com.docker.compose.project=knowledge-contract-scrutator '* ]]; then
  [[ ! -e "$FAKE_DOCKER_STATE/kc-exists" ]] || printf '%s\n' kc-container
  exit 0
fi
if [[ "${1:-}" == inspect ]]; then
  if [[ "${4:-}" == knowledge-contract-scrutator-scrutator-1 ]]; then
    if [[ "${FAKE_KC_HANG_INSPECT:-}" == 1 ]]; then sleep 20; fi
    if [[ -n "${FAKE_KC_INSPECT_READY_AFTER:-}" ]]; then
      count="$(cat "$FAKE_DOCKER_STATE/kc-inspect-count" 2>/dev/null || printf 0)"
      count=$((count + 1))
      printf '%s\n' "$count" >"$FAKE_DOCKER_STATE/kc-inspect-count"
      if ((count <= FAKE_KC_INSPECT_READY_AFTER)); then exit 1; fi
    fi
    [[ -e "$FAKE_DOCKER_STATE/kc-exists" ]] || exit 1
    case "${3:-}" in
      '{{.Image}}') cat "$FAKE_DOCKER_STATE/kc-running-image" ;;
      '{{.State.Running}}') printf '%s\n' true ;;
      *) exit 97 ;;
    esac
    exit 0
  fi
  [[ "${4:-}" == "$(cat "$FAKE_DOCKER_STATE/container")" ]] || exit 1
  case "${3:-}" in
    '{{.Image}}') cat "$FAKE_DOCKER_STATE/running" ;;
    '{{.State.Running}}') cat "$FAKE_DOCKER_STATE/is-running" ;;
    *) exit 97 ;;
  esac
  exit 0
fi
if [[ "${1:-}" == tag ]]; then
  id="$(ref_id "${2:-}")" || exit 1
  case "${3:-}" in
    *:latest) tag=latest ;;
    *:previous) tag=previous ;;
    muneral-api:*)
      tag="release-${3#muneral-api:}"
      [[ "${3#muneral-api:}" =~ ^[0-9a-f]{40}$ ]] || exit 97
      ;;
    *) exit 97 ;;
  esac
  printf '%s\n' "$id" >"$FAKE_DOCKER_STATE/$tag"
  exit 0
fi
if [[ "${1:-}" == compose ]]; then
  if [[ " $* " == *' -p knowledge-contract-scrutator '* ]]; then
    if [[ " $* " == *' config --format json '* ]]; then
      cat "$FAKE_DOCKER_STATE/kc-config.json"; exit 0
    fi
    if [[ " $* " == *' config --images '* ]]; then
      if [[ "${FAKE_KC_IMAGE_FROM_CHECKOUT:-}" == 1 ]]; then
        compose_file=''
        prev=''
        for arg in "$@"; do [[ "$prev" == -f ]] && compose_file="$arg"; prev="$arg"; done
        sed -n 's/^# image=//p' "$compose_file" | tail -1; exit 0
      fi
      printf '%s\n' 'scrutator-deploy:16a4061f0493fef5fc159e252cd793185ec2283c'; exit 0
    fi
    if [[ " $* " == *' up -d --no-build --no-deps scrutator '* ||
          " $* " == *' up -d --force-recreate --no-build --no-deps scrutator '* ]]; then
      touch "$FAKE_DOCKER_STATE/kc-exists"
      if [[ "${FAKE_KC_IMAGE_FROM_CHECKOUT:-}" == 1 ]]; then
        compose_file=''
        prev=''
        for arg in "$@"; do [[ "$prev" == -f ]] && compose_file="$arg"; prev="$arg"; done
        ref_id "$(sed -n 's/^# image=//p' "$compose_file" | tail -1)" >"$FAKE_DOCKER_STATE/kc-running-image"
        printf '\n' >>"$FAKE_DOCKER_STATE/kc-running-image"
      fi
      if [[ "${FAKE_KC_FAIL_UPGRADE_HEALTH:-}" == 1 && " $* " == *' --force-recreate '* ]]; then
        count="$(cat "$FAKE_DOCKER_STATE/kc-up-count" 2>/dev/null || printf 0)"
        count=$((count + 1))
        printf '%s\n' "$count" >"$FAKE_DOCKER_STATE/kc-up-count"
      fi
      [[ "${FAKE_KC_UP_FAIL:-}" != 1 ]] || exit 1
      exit 0
    fi
    if [[ " $* " == *' down '* ]]; then
      [[ "${FAKE_KC_DOWN_FAIL:-}" != 1 ]] || exit 1
      rm -f "$FAKE_DOCKER_STATE/kc-exists"; exit 0
    fi
    if [[ " $* " == *' config -q '* ]]; then exit 0; fi
  fi
  if [[ " $* " == *" ps -q muneral-api "* ]]; then
    cat "$FAKE_DOCKER_STATE/container"
    exit 0
  fi
  if [[ " $* " == *" up -d --force-recreate muneral-api "* ]]; then
    if [[ -n "${FAKE_DOCKER_RESTORED_IMAGE:-}" ]]; then
      printf '%s\n' "$FAKE_DOCKER_RESTORED_IMAGE" >"$FAKE_DOCKER_STATE/running"
    else
      cat "$FAKE_DOCKER_STATE/latest" >"$FAKE_DOCKER_STATE/running"
    fi
  fi
  printf 'FAKE_DOCKER IMAGE_TAG=%s BUILD_SHA=%s ARGV=%s\n' \
    "${IMAGE_TAG:-<unset>}" "${BUILD_SHA:-<unset>}" "$*"
  exit 0
fi
exit 0
SH
chmod 0755 "$fake_docker"
fake_curl="${bin_root}/curl"
cat >"$fake_curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_CURL_LOG"
if [[ "$*" == *'http://127.0.0.1:8310/health'* ]]; then
  printf '%s' "${FAKE_KC_SHARED_STATUS:-200}"; exit 0
fi
if [[ "$*" == *'http://127.0.0.1:8311/health'* ]]; then
  [[ -e "$FAKE_DOCKER_STATE/kc-exists" ]] || exit 1
  if [[ "${FAKE_KC_FAIL_UPGRADE_HEALTH:-}" == 1 &&
        "$(cat "$FAKE_DOCKER_STATE/kc-up-count" 2>/dev/null || printf 0)" == 1 ]]; then
    printf '503'; exit 0
  fi
  if [[ -n "${FAKE_KC_READY_AFTER:-}" ]]; then
    count="$(cat "$FAKE_DOCKER_STATE/kc-health-count" 2>/dev/null || printf 0)"
    count=$((count + 1))
    printf '%s\n' "$count" >"$FAKE_DOCKER_STATE/kc-health-count"
    if ((count <= FAKE_KC_READY_AFTER)); then printf '503'; exit 0; fi
  fi
  printf '%s' "${FAKE_KC_PROJECT_STATUS:-200}"; exit 0
fi
[[ "$*" == *"--max-time 5"* && "$*" == *"http://127.0.0.1:3500/health"* ]] || exit 97
[[ -s "$FAKE_DOCKER_STATE/health-status" ]] || exit 97
cat "$FAKE_DOCKER_STATE/health-status"
exit "$(cat "$FAKE_DOCKER_STATE/health-exit")"
SH
chmod 0755 "$fake_curl"
sed -i \
  -e "s#^readonly DOCKER=.*#readonly DOCKER='${fake_docker}'#" \
  -e "s#^readonly CURL=.*#readonly CURL='${fake_curl}'#" \
  "$broker"

reset_docker_fixture() {
  local latest="$1" running="$2" previous="${3:-}"
  printf '%s\n' "$latest" >"$fake_docker_state/latest"
  printf '%s\n' "$running" >"$fake_docker_state/running"
  if [[ -n "$previous" ]]; then
    printf '%s\n' "$previous" >"$fake_docker_state/previous"
  else
    rm -f -- "$fake_docker_state/previous"
  fi
  printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    >"$fake_docker_state/container"
  printf '%s\n' true >"$fake_docker_state/is-running"
  printf '%s\n' 200 >"$fake_docker_state/health-status"
  printf '%s\n' 0 >"$fake_docker_state/health-exit"
  : >"$fake_docker_log"
  : >"$fake_curl_log"
  unset FAKE_DOCKER_RESTORED_IMAGE
}
fixture_live_image="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
fixture_old_image="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
fixture_new_image="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
reset_docker_fixture "$fixture_live_image" "$fixture_live_image" "$fixture_old_image"

expect_pass image_tag_pinned_to_checkout_head verdicus pull
grep -Fq "IMAGE_TAG=${verdicus_head}" \
  "${fixture_dir}/image_tag_pinned_to_checkout_head.out" || {
  echo "FAIL: IMAGE_TAG was not pinned to the checkout HEAD" >&2
  cat "${fixture_dir}/image_tag_pinned_to_checkout_head.out" >&2
  exit 1
}
grep -Fqv 'IMAGE_TAG=<unset>' \
  "${fixture_dir}/image_tag_pinned_to_checkout_head.out"

# ---------------------------------------------------------------------------
# A2-260 — the muneral BUILDSHA row.
#
# muneral's docker-compose.prod.yml passes `MUNERAL_BUILD_SHA: ${BUILD_SHA:-}`
# as a build arg so /health can name the commit the image was built from
# (A2-255). `:-` means an unexported variable does not fail the build: it
# resolves to empty, the image bakes nothing, and production answers
# `build.sha: null`. That is a gap that reports success, so the assertion has
# to read the VALUE the broker exported rather than the exit code.
#
# `build` is the verb that matters — the arg is consumed at build time — so it
# is the verb this drives.
# ---------------------------------------------------------------------------
expect_pass build_sha_pinned_to_checkout_head_for_muneral muneral build
grep -Fq "BUILD_SHA=${muneral_head}" \
  "${fixture_dir}/build_sha_pinned_to_checkout_head_for_muneral.out" || {
  echo "FAIL: BUILD_SHA was not pinned to muneral's checkout HEAD" >&2
  cat "${fixture_dir}/build_sha_pinned_to_checkout_head_for_muneral.out" >&2
  exit 1
}

# The two tables are separate capabilities and must not leak into each other:
# muneral BUILDS its image (BUILD_SHA) and must not acquire the pre-built-image
# pin, while verdicus PULLS one (IMAGE_TAG) and has no build to label. A single
# `compose_env` serves both, which is exactly why each direction is asserted.
grep -Fq 'IMAGE_TAG=<unset>' \
  "${fixture_dir}/build_sha_pinned_to_checkout_head_for_muneral.out" || {
  echo "FAIL: IMAGE_TAG leaked into muneral, which builds rather than pulls" >&2
  cat "${fixture_dir}/build_sha_pinned_to_checkout_head_for_muneral.out" >&2
  exit 1
}
grep -Fq 'BUILD_SHA=<unset>' \
  "${fixture_dir}/image_tag_pinned_to_checkout_head.out" || {
  echo "FAIL: BUILD_SHA leaked into a service that does not declare it" >&2
  cat "${fixture_dir}/image_tag_pinned_to_checkout_head.out" >&2
  exit 1
}

# Muneral image recovery controls use only the fake Docker and curl executables
# installed above. Their mutable image/container state lives under fixture_dir.
reset_docker_fixture "$fixture_live_image" "$fixture_live_image" "$fixture_old_image"
expect_pass muneral_build_preserves_the_running_image_before_build muneral build
[[ "$(cat "$fake_docker_state/previous")" == "$fixture_live_image" ]] || {
  echo 'FAIL: Muneral did not preserve the running immutable image' >&2; exit 1; }
rotate_line="$(grep -nF "tag ${fixture_live_image} muneral-api:previous" "$fake_docker_log" | cut -d: -f1)"
build_line="$(grep -nF 'compose -p muneral' "$fake_docker_log" | grep -F ' build' | cut -d: -f1)"
[[ -n "$rotate_line" && -n "$build_line" && "$rotate_line" -lt "$build_line" ]] || {
  echo 'FAIL: Muneral build did not preserve before compose build' >&2; cat "$fake_docker_log" >&2; exit 1; }
expect_message muneral_build_preserves_the_running_image_before_build \
  'BROKER_TAG_ROTATE_PASS service=muneral'

reset_docker_fixture "$fixture_new_image" "$fixture_live_image" "$fixture_old_image"
expect_fail muneral_build_refuses_a_stale_latest_tag_before_mutation muneral build
expect_message muneral_build_refuses_a_stale_latest_tag_before_mutation \
  'Muneral :latest does not identify the currently running image'
! grep -Eq '^(tag |compose .* build)' "$fake_docker_log" || {
  echo 'FAIL: stale Muneral state was mutated or built' >&2; cat "$fake_docker_log" >&2; exit 1; }
[[ "$(cat "$fake_docker_state/previous")" == "$fixture_old_image" ]] || {
  echo 'FAIL: stale Muneral state changed the previous tag' >&2; exit 1; }

reset_docker_fixture "$fixture_new_image" "$fixture_new_image"
expect_fail muneral_rollback_refuses_missing_previous_before_mutation muneral rollback
expect_message muneral_rollback_refuses_missing_previous_before_mutation \
  'cannot resolve image identity: muneral-api:previous'
! grep -Eq '^(tag |.* up -d --force-recreate)' "$fake_docker_log" || {
  echo 'FAIL: missing previous image reached mutation' >&2; cat "$fake_docker_log" >&2; exit 1; }
[[ ! -s "$fake_curl_log" ]] || { echo 'FAIL: missing previous image reached health' >&2; exit 1; }

reset_docker_fixture "$fixture_new_image" "$fixture_new_image"
printf '%s\n' 'not-an-image-id' >"$fake_docker_state/previous"
expect_fail muneral_rollback_refuses_invalid_previous_identity muneral rollback
expect_message muneral_rollback_refuses_invalid_previous_identity \
  'invalid image identity: muneral-api:previous'
! grep -Eq '^(tag |compose .* up -d --force-recreate)' "$fake_docker_log" || {
  echo 'FAIL: invalid previous identity reached mutation' >&2; cat "$fake_docker_log" >&2; exit 1; }

reset_docker_fixture "$fixture_new_image" "$fixture_new_image" "$fixture_old_image"
expect_pass muneral_rollback_restores_and_checks_the_captured_previous_image muneral rollback
expect_message muneral_rollback_restores_and_checks_the_captured_previous_image \
  "BROKER_ROLLBACK_PASS service=muneral image=${fixture_old_image} health=loopback-200"
grep -Fq 'compose -p muneral' "$fake_docker_log" &&
  grep -Fq 'up -d --force-recreate muneral-api' "$fake_docker_log" || {
    echo 'FAIL: rollback did not recreate only the fixed Muneral service' >&2; cat "$fake_docker_log" >&2; exit 1; }
grep -Fq "compose -p muneral -f ${state_root}/muneral/docker-compose.prod.yml ps -q muneral-api" \
  "$fake_docker_log" || { echo 'FAIL: broker inspected a noncanonical Muneral service route' >&2; exit 1; }
grep -Fq 'inspect --format {{.Image}} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  "$fake_docker_log" || { echo 'FAIL: broker did not inspect the fixed container image identity' >&2; exit 1; }
grep -Fq 'http://127.0.0.1:3500/health' "$fake_curl_log" || {
  echo 'FAIL: rollback did not use the fixed loopback health endpoint' >&2; exit 1; }

reset_docker_fixture "$fixture_new_image" "$fixture_new_image" "$fixture_old_image"
export FAKE_DOCKER_RESTORED_IMAGE="$fixture_live_image"
expect_fail muneral_rollback_refuses_a_healthy_wrong_image muneral rollback
expect_message muneral_rollback_refuses_a_healthy_wrong_image \
  'Muneral container image does not match the broker-expected image'
grep -Fq 'http://127.0.0.1:3500/health' "$fake_curl_log" || {
  echo 'FAIL: healthy wrong-image refusal did not exercise the fake HTTP 200' >&2; exit 1; }
! grep -Fq 'BROKER_ROLLBACK_PASS' \
  "${fixture_dir}/muneral_rollback_refuses_a_healthy_wrong_image.out" || {
  echo 'FAIL: rollback reported PASS for the wrong image' >&2; exit 1; }
unset FAKE_DOCKER_RESTORED_IMAGE

reset_docker_fixture "$fixture_new_image" "$fixture_new_image" "$fixture_old_image"
printf '%s\n' 503 >"$fake_docker_state/health-status"
printf '%s\n' 22 >"$fake_docker_state/health-exit"
expect_fail muneral_rollback_refuses_failed_loopback_health muneral rollback
expect_message muneral_rollback_refuses_failed_loopback_health \
  'Muneral loopback health check failed'
! grep -Fq 'BROKER_ROLLBACK_PASS' \
  "${fixture_dir}/muneral_rollback_refuses_failed_loopback_health.out" || {
  echo 'FAIL: rollback reported PASS after failed health' >&2; exit 1; }
[[ "$(wc -l <"$fake_curl_log")" -eq 3 ]] || {
  echo 'FAIL: health retry count was not bounded at three' >&2; exit 1; }

reset_docker_fixture "$fixture_live_image" "$fixture_live_image" "$fixture_old_image"
expect_pass muneral_tag_release_uses_only_checkout_head muneral tag-release
expect_pass muneral_image_id_uses_only_checkout_head muneral image-id
grep -Fq "muneral-api:${muneral_head}" "$fake_docker_log" || {
  echo 'FAIL: Muneral release tag was not derived from checkout HEAD' >&2; cat "$fake_docker_log" >&2; exit 1; }
expected_release_image="$(cat "$fake_docker_state/release-${muneral_head}")"
printf '%s\n' "$expected_release_image" >"$fake_docker_state/running"
expect_pass muneral_verify_checks_root_derived_image_and_health muneral verify
expect_message muneral_verify_checks_root_derived_image_and_health \
  "BROKER_VERIFY_PASS service=muneral image=${expected_release_image} health=loopback-200"
expect_fail muneral_verify_rejects_caller_image_identity muneral verify "$fixture_old_image"
expect_message muneral_verify_rejects_caller_image_identity 'verify takes no arguments'
expect_fail muneral_rollback_rejects_caller_image_identity muneral rollback "$fixture_old_image"
expect_message muneral_rollback_rejects_caller_image_identity 'rollback takes no arguments'

reset_docker_fixture "$fixture_live_image" "$fixture_live_image" "$fixture_old_image"
expect_pass other_service_tag_rotate_retains_existing_latest_recipe transcribator-api tag-rotate
expect_message other_service_tag_rotate_retains_existing_latest_recipe \
  'BROKER_TAG_ROTATE_PASS service=transcribator-api transcribator-api:latest -> transcribator-api:previous'

# A service NOT in IMAGETAG must not have the variable exported at all —
# otherwise the pin would leak across services and a compose file that happens
# to reference IMAGE_TAG would silently pick up a foreign commit.
expect_pass image_tag_absent_for_other_services muneral pull
grep -Fq 'IMAGE_TAG=<unset>' \
  "${fixture_dir}/image_tag_absent_for_other_services.out" || {
  echo "FAIL: IMAGE_TAG leaked into a service that does not declare it" >&2
  cat "${fixture_dir}/image_tag_absent_for_other_services.out" >&2
  exit 1
}


# INFRA-0417 — the environment must land BESIDE the compose file.
#
# `docker compose -f <file>` resolves `.env` relative to that file. For a
# service whose compose sits in a subdirectory, an `.env` installed in the root
# of the checkout is simply never read — the stack comes up with whatever the
# image bakes in, and every `${VAR}` interpolates to empty. That failure is
# silent: the container starts, and only a consumer notices.
#
# model-connector is the case that has a subdirectory compose file, so it is
# what this asserts.
mc_checkout="${state_root}/stt-whisper"
mkdir -p "${mc_checkout}/deploy/stt-whisper"
git -C "$mc_checkout" init -q
git -C "$mc_checkout" -c user.email=t@example.invalid -c user.name=t \
  commit -q --allow-empty -m 'fixture head'
printf '%s\n' 'services: {}' >"${mc_checkout}/deploy/stt-whisper/docker-compose.yml"
printf '%s\n' 'STT_BIND_IP=203.0.113.9' >"${env_root}/stt-whisper.env"

# install_env runs from `sync`, so the placement is asserted by calling the
# function directly against the fixture rather than by driving a full sync,
# which would need a reachable remote.
check_env_placement() {
  local name="$1" svc="$2" expected="$3" unexpected="$4"
  rm -f -- "$expected" "$unexpected"
  # shellcheck disable=SC1090
  ( set -euo pipefail
    # Source the broker with a no-op main so its tables and functions are
    # available without executing a command.
    eval "$(sed 's/^main "\$@"$/:/' "$broker")"
    install_env "$svc"
  )
  if [ ! -f "$expected" ]; then
    echo "FAIL: ${name}: env not installed at ${expected}" >&2
    exit 1
  fi
  if [ -e "$unexpected" ]; then
    echo "FAIL: ${name}: env also landed at ${unexpected}" >&2
    exit 1
  fi
  echo "PASS: ${name}"
}

check_env_placement env_installed_beside_subdirectory_compose stt-whisper \
  "${mc_checkout}/deploy/stt-whisper/.env" "${mc_checkout}/.env"
grep -Fq 'STT_BIND_IP=203.0.113.9' "${mc_checkout}/deploy/stt-whisper/.env"

# A root-level compose file must keep landing exactly where it always did.
check_env_placement env_still_at_root_for_root_level_compose verdicus \
  "${state_root}/verdicus/.env" "${state_root}/verdicus/deploy/.env"

# ---------------------------------------------------------------------------
# A2-102b -- the argana rows.
#
# A table-row addition has no code to test, which is exactly why it needs
# tests: every way it can be wrong is a value that LOOKS right and resolves to
# something that does not exist. The three below are the ones that would reach
# production green.
# ---------------------------------------------------------------------------
argana_checkout="${state_root}/argana"
mkdir -p "${argana_checkout}/.git"
printf '%s\n' 'services: {}' >"${argana_checkout}/docker-compose.yml"
# The two variables argana's compose file interpolates its host bind-mount
# paths from. They are in the ENV FILE, which is root-owned, and that is the
# whole reason the runner cannot redirect where the client secret is read from.
cat >"${env_root}/argana.env" <<'ENV'
ARGANA_CLIENT_SECRET_HOST_PATH=/etc/muneral-kb-sync/auth-client-secret
ARGANA_KC2_HOST_ROOT=/var/lib/argana/kc2-pin
ENV

# argana's compose file sits at the root of its checkout, so `.env` must land
# there -- beside the compose file, which is where `docker compose -f <file>`
# resolves it for BOTH `env_file:` and `${VAR}` interpolation. An `.env` that
# landed anywhere else would interpolate both mount paths to their defaults
# silently, and only a wrong mount would ever reveal it.
check_env_placement env_installed_beside_argana_root_compose argana \
  "${argana_checkout}/.env" "${argana_checkout}/deploy/.env"
grep -Fq 'ARGANA_CLIENT_SECRET_HOST_PATH=/etc/muneral-kb-sync/auth-client-secret' \
  "${argana_checkout}/.env"

# The freshness check inspects a container by NAME. That name is
# <project>-<service>-1, so it exists only if PROJECT[argana] is what
# CONTAINER[argana] was derived from. Decoupling the two is a deploy that
# reports success while `docker inspect` fails -- or worse, succeeds against
# some other stack's container. The `<service>` half comes from argana's own
# compose file and cannot be asserted from this repository; the project half
# can, and is the half that lives here.
(
  set -euo pipefail
  # shellcheck disable=SC1090
  eval "$(sed 's/^main "\$@"$/:/' "$broker")"
  [[ "${CONTAINER[argana]}" == "${PROJECT[argana]}-"* ]] || {
    echo "FAIL: CONTAINER[argana]=${CONTAINER[argana]} is not inside PROJECT[argana]=${PROJECT[argana]}" >&2
    exit 1
  }
)
echo 'PASS: argana_container_name_is_inside_the_pinned_project'

# And the same pairing end to end: `up` must create the project that
# `freshness` then inspects into. A fake docker records argv so the assertions
# read the VALUES the broker passed, not merely its exit code.
fake_docker_log="${fixture_dir}/argana-docker.log"
: >"$fake_docker_log"
export FAKE_DOCKER_LOG="$fake_docker_log"
fake_docker_argana="${bin_root}/docker-argana"
cat >"$fake_docker_argana" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_DOCKER_LOG}"
printf 'BUILD_SHA=%s\n' "${BUILD_SHA:-}" >>"${FAKE_DOCKER_LOG}"
if [[ "${1:-}" == 'inspect' ]]; then
  # What `freshness` parses with date(1). A container created now is fresh, so
  # the case asserts the NAME that was inspected rather than the age verdict.
  date -u +%Y-%m-%dT%H:%M:%S.000000000Z
  exit 0
fi
SH
chmod 0755 "$fake_docker_argana"
sed -i -e "s#^readonly DOCKER=.*#readonly DOCKER='${fake_docker_argana}'#" "$broker"

expect_pass argana_up_uses_the_pinned_project argana up
grep -Fq "compose -p argana -f ${argana_checkout}/docker-compose.yml up -d" \
  "$fake_docker_log" || {
  echo 'FAIL: argana up did not run against the pinned project' >&2
  cat "$fake_docker_log" >&2
  exit 1
}

expect_pass argana_freshness_inspects_the_derived_container argana freshness
grep -Fq 'inspect argana-argana-1 --format {{.Created}}' "$fake_docker_log" || {
  echo 'FAIL: argana freshness inspected an unexpected container' >&2
  cat "$fake_docker_log" >&2
  exit 1
}
expect_message argana_freshness_inspects_the_derived_container \
  'BROKER_FRESHNESS_PASS service=argana'

# The new private API uses only the fixed checkout, pinned compose project and
# broker-derived build SHA. No environment file or registry credential is needed.
api_checkout="${state_root}/contract-place-api"
mkdir -p "$api_checkout"
git -C "$api_checkout" init -q
git -C "$api_checkout" -c user.email=t@example.invalid -c user.name=t \
  commit -q --allow-empty -m 'fixture API head'
api_head="$(git -C "$api_checkout" rev-parse HEAD)"
printf '%s\n' 'services: {api: {}}' >"${api_checkout}/docker-compose.yml"
: >"$fake_docker_log"
expect_pass contract_place_api_up_uses_fixed_project contract-place-api up
grep -Fq "compose -p contract-place-api -f ${api_checkout}/docker-compose.yml up -d" \
  "$fake_docker_log" || { echo 'FAIL: API compose project or path drifted' >&2; exit 1; }
grep -Fxq "BUILD_SHA=${api_head}" "$fake_docker_log" || {
  echo 'FAIL: API build SHA did not come from broker checkout HEAD' >&2
  exit 1
}
expect_fail contract_place_api_has_no_root_script contract-place-api run-deploy
expect_message contract_place_api_has_no_root_script \
  'service has no deploy script: contract-place-api'
expect_fail contract_place_api_has_no_registry_login contract-place-api registry-login Arcanada
expect_message contract_place_api_has_no_registry_login \
  'may not establish a registry credential: contract-place-api'

# Admitting a service to the DEPLOY allowlist must not admit it to anything
# else. argana builds from its checkout and never pulls a private image, so it
# has no REGISTRY_AUTH row; and its workflow drives build/up itself, so it has
# no SCRIPT row. Both refusals are asserted by message, because expect_fail
# alone would be satisfied by a failure for the wrong reason.
expect_fail argana_may_not_establish_a_registry_credential \
  argana registry-login Arcanada
expect_message argana_may_not_establish_a_registry_credential \
  'may not establish a registry credential: argana'

expect_fail argana_has_no_root_deploy_script argana run-deploy
expect_message argana_has_no_root_deploy_script \
  'service has no deploy script: argana'

# The repository is PRIVATE, so `sync` must demand a fetch credential on stdin
# BEFORE it touches the network. The fake git makes the difference visible: if
# the AUTH row were missing, sync would fall through to a clone, and the case
# would still "fail" -- for the wrong reason, and only because the clone of a
# private repository fails. The message and the absence of FAKE_GIT_REACHED are
# what make this case mean something.
fake_git="${bin_root}/git"
cat >"$fake_git" <<'SH'
#!/usr/bin/env bash
printf 'FAKE_GIT_REACHED %s\n' "$*" >&2
exit 97
SH
chmod 0755 "$fake_git"
sed -i -e "s#^readonly GIT=.*#readonly GIT='${fake_git}'#" "$broker"

expect_fail argana_sync_requires_a_fetch_credential \
  argana sync 0000000000000000000000000000000000000000 </dev/null
expect_message argana_sync_requires_a_fetch_credential \
  'this service needs a fetch credential on stdin'
expect_fail contract_place_api_sync_requires_a_fetch_credential \
  contract-place-api sync 0000000000000000000000000000000000000000 </dev/null
expect_message contract_place_api_sync_requires_a_fetch_credential \
  'this service needs a fetch credential on stdin'
if grep -Fq 'FAKE_GIT_REACHED' \
  "${fixture_dir}/argana_sync_requires_a_fetch_credential.out"; then
  echo 'FAIL: sync reached git without demanding a credential' >&2
  exit 1
fi

echo 'All aggregate readback broker cases passed.'

# Billing preparation never registers a live service or enables a legacy verb.
expect_fail billing_atomic_check_unregistered billing-arcana atomic-check "$muneral_head"
expect_fail billing_atomic_deploy_unregistered billing-arcana atomic-deploy "$muneral_head"
expect_fail billing_legacy_sync_unregistered billing-arcana sync "$muneral_head"

# ---------------------------------------------------------------------------
# sync must REFUSE tracked drift (never discard it) and verify an exact clean tracked state after the checkout.
# The case that matters: a tracked file changed locally and identical in the old and new commit.
sync_origin="${fixture_dir}/sync-origin.git"
sync_seed="${fixture_dir}/sync-seed"
git init -q --bare -b main "$sync_origin"
git init -q -b main "$sync_seed"
mkdir -p "${sync_seed}/alloy"
printf '%s\n' 'reviewed config' >"${sync_seed}/alloy/config.alloy"
printf '%s\n' 'compose' >"${sync_seed}/docker-compose.yml"
printf '%s\n' 'one' >"${sync_seed}/other.txt"
git_t() { git -c user.email=t@example.invalid -c user.name=t "$@"; }
git_t -C "$sync_seed" add -A
git_t -C "$sync_seed" commit -q -m c1
sync_c1="$(git -C "$sync_seed" rev-parse HEAD)"
printf '%s\n' 'two' >"${sync_seed}/other.txt"
git_t -C "$sync_seed" commit -q -am c2
sync_c2="$(git -C "$sync_seed" rev-parse HEAD)"
git -C "$sync_seed" push -q "$sync_origin" main
printf '%s\n' 'ENV=1' >"${env_root}/arcanada-assistant.env"

# The `$broker` copy above had GIT replaced by a fake; sync needs the real git.
real_broker="${fixture_dir}/broker-real-git"
sed "s#^readonly GIT=.*#readonly GIT='$(command -v git)'#" "$broker" >"$real_broker"
chmod 0755 "$real_broker"
sync_dir="${state_root}/arcanada-assistant"
sync_out="${fixture_dir}/sync.out"

# Fresh checkout at c1 (clean).
sync_reset() {
  rm -rf -- "$sync_dir"
  git clone -q "$sync_origin" "$sync_dir"
  git -C "$sync_dir" checkout -q --detach "$sync_c1"
}
sync_rc() { "$real_broker" arcanada-assistant sync "$sync_c2" >"$sync_out" 2>&1 && echo 0 || echo "$?"; }
expect_refused_drift() {
  local name="$1"
  if [ "$(sync_rc)" = 0 ]; then echo "FAIL: ${name}: drift was not refused" >&2; exit 1; fi
  grep -Fq 'BROKER_SYNC_REFUSED_DRIFT service=arcanada-assistant' "$sync_out" || {
    echo "FAIL: ${name}: no BROKER_SYNC_REFUSED_DRIFT line" >&2; sed -n '1,20p' "$sync_out" >&2; exit 1; }
  if grep -Fq 'BROKER_SYNC_PASS' "$sync_out"; then echo "FAIL: ${name}: PASS printed" >&2; exit 1; fi
  if grep -Fq 'LOCAL ROLLBACK EDIT' "$sync_out"; then echo "FAIL: ${name}: file content leaked" >&2; exit 1; fi
  [ "$(git -C "$sync_dir" rev-parse HEAD)" = "$sync_c1" ] || { echo "FAIL: ${name}: HEAD moved" >&2; exit 1; }
  echo "PASS: ${name}"
}

# RED: unstaged tracked edit in a file identical across c1/c2 (the case --force destroyed). Bytes preserved,
# metadata sanitized (a sha256, the path, status letters), untracked files untouched because nothing ran.
sync_reset
printf '%s\n' 'LOCAL ROLLBACK EDIT' >"${sync_dir}/alloy/config.alloy"
printf '%s\n' 'untracked custody' >"${sync_dir}/stray.txt"
expected_hash="$(sha256sum "${sync_dir}/alloy/config.alloy" | cut -d' ' -f1)"
expect_refused_drift sync_refuses_unstaged_tracked_drift
grep -Fq "sha256=${expected_hash}" "$sync_out" && grep -Fq 'path=alloy/config.alloy' "$sync_out" ||
  { echo 'FAIL: drift metadata lacks the path or digest' >&2; exit 1; }
[ "$(cat "${sync_dir}/alloy/config.alloy")" = 'LOCAL ROLLBACK EDIT' ] || { echo 'FAIL: drift bytes were not preserved' >&2; exit 1; }
[ -f "${sync_dir}/stray.txt" ] || { echo 'FAIL: refusal ran clean' >&2; exit 1; }

# RED: index-only drift (staged, worktree equals index).
sync_reset
printf '%s\n' 'LOCAL ROLLBACK EDIT' >"${sync_dir}/alloy/config.alloy"
git -C "$sync_dir" add alloy/config.alloy
expect_refused_drift sync_refuses_staged_tracked_drift
git -C "$sync_dir" diff --cached --quiet && { echo 'FAIL: staged change was dropped' >&2; exit 1; }
[ "$(cat "${sync_dir}/alloy/config.alloy")" = 'LOCAL ROLLBACK EDIT' ] || { echo 'FAIL: staged worktree bytes lost' >&2; exit 1; }

# RED: drift in a file that also differs between c1 and c2.
sync_reset
printf '%s\n' 'LOCAL ROLLBACK EDIT' >"${sync_dir}/other.txt"
expect_refused_drift sync_refuses_drift_in_a_changed_file

# RED: drift hidden from `git status` by assume-unchanged.
sync_reset
git -C "$sync_dir" update-index --assume-unchanged alloy/config.alloy
printf '%s\n' 'LOCAL ROLLBACK EDIT' >"${sync_dir}/alloy/config.alloy"
expect_refused_drift sync_refuses_assume_unchanged_hidden_edit

# RED: a failed query is not a clean tree. A git shim fails ONE subcommand; the checkout is dirty, which the
# failed query would otherwise hide. Nothing may move: no fetch, checkout, clean or env.
shim_dir="${fixture_dir}/gitshim"
mkdir -p "$shim_dir"
cat >"${shim_dir}/git" <<SH
#!/usr/bin/env bash
# Fails the subcommand named in FAIL_GIT (optionally only when FAIL_GIT_ARG appears) with FAIL_GIT_RC.
real='$(command -v git)'
for a in "\$@"; do
  if [ "\$a" = "\${FAIL_GIT:-}" ] && { [ -z "\${FAIL_GIT_ARG:-}" ] || [[ " \$* " == *" \${FAIL_GIT_ARG} "* ]]; }; then
    echo "shim: injected failure for \$a" >&2
    exit "\${FAIL_GIT_RC:-1}"
  fi
done
exec "\$real" "\$@"
SH
chmod 0755 "${shim_dir}/git"
shim_broker="${fixture_dir}/broker-shim-git"
sed "s#^readonly GIT=.*#readonly GIT='${shim_dir}/git'#" "$broker" >"$shim_broker"
chmod 0755 "$shim_broker"
expect_refused_query() {
  local name="$1" sub="$2" arg="$3" rc="$4"
  sync_reset
  printf '%s\n' 'LOCAL ROLLBACK EDIT' >"${sync_dir}/alloy/config.alloy"
  printf '%s\n' 'untracked custody' >"${sync_dir}/stray.txt"
  if FAIL_GIT="$sub" FAIL_GIT_ARG="$arg" FAIL_GIT_RC="$rc" "$shim_broker" arcanada-assistant sync "$sync_c2" >"$sync_out" 2>&1; then
    echo "FAIL: ${name}: a failed query was accepted" >&2; exit 1
  fi
  grep -Fq 'BROKER_SYNC_REFUSED_QUERY service=arcanada-assistant' "$sync_out" || {
    echo "FAIL: ${name}: no BROKER_SYNC_REFUSED_QUERY line" >&2; sed -n '1,20p' "$sync_out" >&2; exit 1; }
  if grep -Fq 'BROKER_SYNC_PASS' "$sync_out"; then echo "FAIL: ${name}: PASS printed" >&2; exit 1; fi
  [ "$(git -C "$sync_dir" rev-parse HEAD)" = "$sync_c1" ] || { echo "FAIL: ${name}: HEAD moved" >&2; exit 1; }
  [ "$(cat "${sync_dir}/alloy/config.alloy")" = 'LOCAL ROLLBACK EDIT' ] || { echo "FAIL: ${name}: bytes lost" >&2; exit 1; }
  [ -f "${sync_dir}/stray.txt" ] || { echo "FAIL: ${name}: clean ran" >&2; exit 1; }
  echo "PASS: ${name}"
}
expect_refused_query sync_refuses_when_status_query_fails status '' 1
expect_refused_query sync_refuses_when_status_query_dies status '' 128
expect_refused_query sync_refuses_when_ls_files_query_fails ls-files '' 1
expect_refused_query sync_refuses_when_hidden_flag_ls_files_fails ls-files -v 1
expect_refused_query sync_refuses_when_diff_cached_exits_128 diff --cached 128
expect_refused_query sync_refuses_when_diff_cached_exits_2 diff --cached 2
# The shim itself is transparent when nothing is injected: a clean tree still syncs through it.
sync_reset
if ! "$shim_broker" arcanada-assistant sync "$sync_c2" >"$sync_out" 2>&1; then
  echo 'FAIL: the git shim is not transparent' >&2; sed -n '1,20p' "$sync_out" >&2; exit 1
fi
echo 'PASS: git_shim_is_transparent_and_clean_sync_passes'

# The global force behaviour is gone.
if grep -Eq 'checkout[^#]*--force|reset --hard' "$subject"; then
  echo 'FAIL: sync still force-discards tracked edits' >&2
  exit 1
fi
echo 'PASS: sync_has_no_force_or_reset'

# GREEN: a clean tree syncs, stray untracked files go, and the exact tracked state is verified.
sync_reset
printf '%s\n' 'untracked' >"${sync_dir}/stray.txt"
[ "$(sync_rc)" = 0 ] || { echo 'FAIL: clean sync failed' >&2; sed -n '1,20p' "$sync_out" >&2; exit 1; }
grep -Fq "BROKER_SYNC_PASS service=arcanada-assistant sha=${sync_c2}" "$sync_out" || { echo 'FAIL: no PASS line' >&2; exit 1; }
[ "$(git -C "$sync_dir" rev-parse HEAD)" = "$sync_c2" ] || { echo 'FAIL: HEAD is not c2' >&2; exit 1; }
[ -z "$(git -C "$sync_dir" status --porcelain --untracked-files=no)" ] || { echo 'FAIL: tracked state not clean' >&2; exit 1; }
[ ! -e "${sync_dir}/stray.txt" ] || { echo 'FAIL: untracked file survived clean' >&2; exit 1; }
[ "$(cat "${sync_dir}/other.txt")" = two ] || { echo 'FAIL: checkout did not land c2' >&2; exit 1; }
echo 'PASS: sync_clean_tree_syncs_and_verifies'

# KCP-0017: the project row cannot reach generic root Compose verbs, and its
# rollback names only the separate project. No live Docker or secret is used.
kc_dir="${state_root}/knowledge-contract-scrutator"
mkdir -p "${kc_dir}/.git" "${kc_dir}/deploy/knowledge-contract-scrutator"
printf '%s\n' 'services: {scrutator: {image: fixture}}' \
  >"${kc_dir}/deploy/knowledge-contract-scrutator/compose.yml"
expect_fail kc_generic_up_refused knowledge-contract-scrutator up
expect_message kc_generic_up_refused 'allows only kc-deploy, kc-upgrade, kc-status and kc-stop'
expect_fail kc_bad_sha_refused knowledge-contract-scrutator kc-deploy not-a-sha
expect_message kc_bad_sha_refused 'release sha must be 40 lowercase hex'
expect_fail kc_missing_env_refused knowledge-contract-scrutator kc-deploy \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
expect_message kc_missing_env_refused 'root-owned env file missing'
: >"$fake_docker_log"
expect_pass kc_project_only_stop knowledge-contract-scrutator kc-stop
grep -Fq "compose -p knowledge-contract-scrutator -f ${kc_dir}/deploy/knowledge-contract-scrutator/compose.yml down" \
  "$fake_docker_log" || { echo 'FAIL: kc-stop did not target the fixed project' >&2; exit 1; }
if grep -Fq 'scrutator-deploy' "$fake_docker_log"; then
  echo 'FAIL: kc-stop referenced the shared Scrutator transaction' >&2; exit 1
fi

# Drive the first-install path against a local main and fake Docker. This
# measures the readback and rollback branches without touching production.
kc_source="${fixture_dir}/kc-source"
kc_remote="${fixture_dir}/kc-remote.git"
mkdir -p "$kc_source/deploy/knowledge-contract-scrutator"
printf '%s\n' 'services: {scrutator: {image: fixture}}' >"$kc_source/deploy/knowledge-contract-scrutator/compose.yml"
git -C "$kc_source" init -q -b main
git -C "$kc_source" -c user.email=t@example.invalid -c user.name=t add .
git -C "$kc_source" -c user.email=t@example.invalid -c user.name=t commit -qm fixture
kc_head="$(git -C "$kc_source" rev-parse HEAD)"
git init -q --bare "$kc_remote"
git -C "$kc_remote" symbolic-ref HEAD refs/heads/main
git -C "$kc_source" remote add origin "$kc_remote"
git -C "$kc_source" push -q origin main
kc_broker="${fixture_dir}/kc-broker"
sed "s#\[knowledge-contract-scrutator\]='https://github.com/Arcanada-one/contract-place-api.git'#\[knowledge-contract-scrutator\]='${kc_remote}'#" "$broker" >"$kc_broker"
sed -i -e "s#^readonly DOCKER=.*#readonly DOCKER='${fake_docker}'#" \
  -e "s#^readonly CURL=.*#readonly CURL='${fake_curl}'#" \
  -e "s#^readonly GIT=.*#readonly GIT='/usr/bin/git'#" \
  -e "s#install -d -m 0755 -o root -g root#install -d -m 0755 -o ${owner} -g $(id -gn)#" "$kc_broker"
sed -i -e "s#^readonly KC_READINESS_TIMEOUT=.*#readonly KC_READINESS_TIMEOUT=3#" \
  -e "s#^readonly KC_READINESS_POLL_SECONDS=.*#readonly KC_READINESS_POLL_SECONDS=1#" \
  -e "s#^readonly KC_INSPECT_TIMEOUT=.*#readonly KC_INSPECT_TIMEOUT=1#" \
  -e "s#^readonly KC_LOG_TIMEOUT=.*#readonly KC_LOG_TIMEOUT=1#" \
  -e "s#^readonly KC_DIAGNOSTIC_ROOT=.*#readonly KC_DIAGNOSTIC_ROOT='${fixture_dir}/kc-diagnostics'#" \
  -e "s#== root:700#== ${owner}:700#" "$kc_broker"
chmod 0755 "$kc_broker"
rm -rf -- "$kc_dir"
printf '%s\n' 'SCRUTATOR_DATABASE_URL=postgresql://kc_scrutator_app:fixture@100.97.136.74:5432/knowledge_contract' >"${env_root}/knowledge-contract-scrutator.env"
chmod 0600 "${env_root}/knowledge-contract-scrutator.env"
cat >"$fake_docker_state/kc-config.json" <<'JSON'
{"name":"knowledge-contract-scrutator","networks":{"default":{"name":"knowledge-contract-scrutator_default","ipam":{}}},"services":{"scrutator":{"container_name":"knowledge-contract-scrutator-scrutator-1","image":"scrutator-deploy:16a4061f0493fef5fc159e252cd793185ec2283c","networks":{"default":null},"ports":[{"mode":"ingress","target":8310,"published":"8311","protocol":"tcp","host_ip":"127.0.0.1"}],"environment":{"SCRUTATOR_HOST":"0.0.0.0","SCRUTATOR_PORT":"8310","SCRUTATOR_AUTH_ENFORCE":"true","SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL":"https://auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect","SCRUTATOR_AUTH_SERVICE_AUDIENCE":"urn:arcanada:scrutator:knowledge-contract","SCRUTATOR_AUTH_SERVICE_SCOPE":"kb:knowledge-contract.read","SCRUTATOR_FEEDER_NAMESPACES":"knowledge-contract","SCRUTATOR_DATABASE_URL":"postgresql://kc_scrutator_app:fixture@100.97.136.74:5432/knowledge_contract"},"command":null,"entrypoint":null,"restart":"unless-stopped","healthcheck":{"test":["CMD","curl","--fail","--silent","http://127.0.0.1:8310/health"],"timeout":"5s","interval":"30s","retries":3}}}}
JSON
printf '%s\n' 'sha256:ae4a4768ce83f34b3dc7c5b1620f836b8eafef86e32687b43a5c6a4eaa0c0c85' >"$fake_docker_state/kc-running-image"
kc_run() { printf '%s\n' 'fixture-token-abcdefghijklmnopqrstuvwxyz' | "$kc_broker" knowledge-contract-scrutator kc-deploy "$kc_head"; }
[[ ! -e "$fake_docker_state/kc-exists" ]] || { echo 'FAIL: fake project exists before deploy' >&2; exit 1; }
if ! kc_run >"${fixture_dir}/kc-success.out" 2>&1; then
  echo 'FAIL: kc first-install fixture' >&2; sed -n '1,40p' "${fixture_dir}/kc-success.out" >&2
  tail -8 "$fake_docker_log" >&2
  ls -la "$fake_docker_state" >&2
  exit 1
fi
grep -Fq 'KC_PROJECT_DEPLOY_PASS' "${fixture_dir}/kc-success.out" || exit 1
echo 'PASS: kc_first_install_exact_main_and_image'
if kc_run >"${fixture_dir}/kc-existing.out" 2>&1; then echo 'FAIL: existing project accepted' >&2; exit 1; fi
grep -Fq 'initial-install verb refuses upgrades' "${fixture_dir}/kc-existing.out" || exit 1
echo 'PASS: kc_existing_project_refused'
"$kc_broker" knowledge-contract-scrutator kc-stop >"${fixture_dir}/kc-stop.out"
export FAKE_KC_READY_AFTER=1
rm -f "$fake_docker_state/kc-health-count"
if ! kc_run >"${fixture_dir}/kc-delayed-ready.out" 2>&1; then
  echo 'FAIL: delayed project readiness was not accepted' >&2; exit 1
fi
[[ "$(cat "$fake_docker_state/kc-health-count")" -ge 2 ]] || exit 1
"$kc_broker" knowledge-contract-scrutator kc-stop >"${fixture_dir}/kc-delayed-stop.out"
unset FAKE_KC_READY_AFTER
echo 'PASS: kc_delayed_readiness_passes_within_bound'
export FAKE_KC_INSPECT_READY_AFTER=1
rm -f "$fake_docker_state/kc-inspect-count"
if ! kc_run >"${fixture_dir}/kc-delayed-container.out" 2>&1; then
  echo 'FAIL: transient container inspect was not retried' >&2; exit 1
fi
[[ "$(cat "$fake_docker_state/kc-inspect-count")" -ge 2 ]] || exit 1
"$kc_broker" knowledge-contract-scrutator kc-stop >"${fixture_dir}/kc-delayed-container-stop.out"
unset FAKE_KC_INSPECT_READY_AFTER
echo 'PASS: kc_transient_container_inspect_retried'
export FAKE_KC_IMAGE_ID='sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
if kc_run >"${fixture_dir}/kc-image.out" 2>&1; then echo 'FAIL: wrong image accepted' >&2; exit 1; fi
grep -Fq 'project image digest mismatch' "${fixture_dir}/kc-image.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
unset FAKE_KC_IMAGE_ID
echo 'PASS: kc_wrong_image_refused_before_up'
python3 - "$fake_docker_state/kc-config.json" <<'PY'
import json, sys
p = sys.argv[1]
x = json.load(open(p))
x["services"]["scrutator"]["ports"][0]["host_ip"] = "0.0.0.0"
json.dump(x, open(p, "w"))
PY
export PYTHONOPTIMIZE=1
if kc_run >"${fixture_dir}/kc-public-port.out" 2>&1; then echo 'FAIL: public port accepted' >&2; exit 1; fi
grep -Fq 'Compose isolation contract failed' "${fixture_dir}/kc-public-port.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
echo 'PASS: kc_public_port_refused_before_up'
unset PYTHONOPTIMIZE
python3 - "$fake_docker_state/kc-config.json" <<'PY'
import json, sys
p = sys.argv[1]
x = json.load(open(p))
x["services"]["scrutator"]["ports"][0]["host_ip"] = "127.0.0.1"
x["networks"]["default"]["external"] = True
json.dump(x, open(p, "w"))
PY
if kc_run >"${fixture_dir}/kc-external-network.out" 2>&1; then echo 'FAIL: external network accepted' >&2; exit 1; fi
grep -Fq 'Compose isolation contract failed' "${fixture_dir}/kc-external-network.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
python3 - "$fake_docker_state/kc-config.json" <<'PY'
import json, sys
p = sys.argv[1]
x = json.load(open(p))
del x["networks"]["default"]["external"]
json.dump(x, open(p, "w"))
PY
echo 'PASS: kc_external_network_refused_before_up'
for forbidden in volumes_from secrets configs build extends; do
  python3 - "$fake_docker_state/kc-config.json" "$forbidden" <<'PY'
import json, sys
p, key = sys.argv[1:]
x = json.load(open(p))
x["services"]["scrutator"][key] = ["shared-scrutator"]
json.dump(x, open(p, "w"))
PY
  if kc_run >"${fixture_dir}/kc-forbidden-${forbidden}.out" 2>&1; then
    echo "FAIL: ${forbidden} accepted" >&2; exit 1
  fi
  grep -Fq 'Compose isolation contract failed' "${fixture_dir}/kc-forbidden-${forbidden}.out" || exit 1
  [[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
  python3 - "$fake_docker_state/kc-config.json" "$forbidden" <<'PY'
import json, sys
p, key = sys.argv[1:]
x = json.load(open(p))
del x["services"]["scrutator"][key]
json.dump(x, open(p, "w"))
PY
  echo "PASS: kc_${forbidden}_refused_before_up"
done
python3 - "$fake_docker_state/kc-config.json" <<'PY'
import json, sys
p = sys.argv[1]
x = json.load(open(p))
x["services"]["scrutator"]["ports"][0]["host_ip"] = "127.0.0.1"
json.dump(x, open(p, "w"))
PY
export FAKE_KC_PROJECT_STATUS=500
if kc_run >"${fixture_dir}/kc-health.out" 2>&1; then echo 'FAIL: failed health accepted' >&2; exit 1; fi
grep -Fq 'project-only rollback attempted' "${fixture_dir}/kc-health.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
log_path="$(sed -n 's/^KC_PROJECT_DIAGNOSTIC_LOG=//p' "${fixture_dir}/kc-health.out" | tail -1)"
[[ -f "$log_path" && "$(stat -c '%a' "$log_path")" == 600 ]] || exit 1
grep -Fq 'startup diagnostic fixture' "$log_path" || exit 1
grep -Fq '[REDACTED_SENSITIVE_LINE]' "$log_path" || exit 1
if grep -Fq 'synthetic-secret' "$log_path"; then echo 'FAIL: diagnostic log leaked DSN' >&2; exit 1; fi
echo 'PASS: kc_failed_health_stops_project'
export FAKE_KC_HANG_LOGS=1
start_seconds=$SECONDS
if kc_run >"${fixture_dir}/kc-hung-logs.out" 2>&1; then echo 'FAIL: hung logs accepted' >&2; exit 1; fi
[[ $((SECONDS - start_seconds)) -lt 10 ]] || { echo 'FAIL: diagnostic timeout did not bound rollback' >&2; exit 1; }
grep -Fq 'KC_PROJECT_STOP_PASS' "${fixture_dir}/kc-hung-logs.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
unset FAKE_KC_HANG_LOGS
echo 'PASS: kc_hung_logs_do_not_defer_rollback'
export FAKE_KC_HANG_INSPECT=1
start_seconds=$SECONDS
if kc_run >"${fixture_dir}/kc-hung-inspect.out" 2>&1; then echo 'FAIL: hung inspect accepted' >&2; exit 1; fi
[[ $((SECONDS - start_seconds)) -lt 12 ]] || { echo 'FAIL: inspect timeout did not bound rollback' >&2; exit 1; }
grep -Fq 'KC_PROJECT_STOP_PASS' "${fixture_dir}/kc-hung-inspect.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
unset FAKE_KC_HANG_INSPECT
echo 'PASS: kc_hung_inspect_bounded'
export FAKE_KC_DOWN_FAIL=1
if kc_run >"${fixture_dir}/kc-rollback.out" 2>&1; then echo 'FAIL: failed rollback accepted' >&2; exit 1; fi
grep -Fq 'rollback failed; live state unknown' "${fixture_dir}/kc-rollback.out" || exit 1
[[ -e "$fake_docker_state/kc-exists" ]] || exit 1
unset FAKE_KC_DOWN_FAIL FAKE_KC_PROJECT_STATUS
echo 'PASS: kc_failed_rollback_explicitly_refused'
"$kc_broker" knowledge-contract-scrutator kc-stop >"${fixture_dir}/kc-cleanup.out"

# Upgrade reuses the existing project only, pins a new main commit, and keeps
# the previous checkout/container available for bounded rollback.
if ! kc_run >"${fixture_dir}/kc-upgrade-base.out" 2>&1; then exit 1; fi
printf '%s\n' '# upgraded' >>"$kc_source/deploy/knowledge-contract-scrutator/compose.yml"
git -C "$kc_source" add deploy/knowledge-contract-scrutator/compose.yml
git -C "$kc_source" -c user.email=t@example.invalid -c user.name=t commit -qm upgraded
kc_next="$(git -C "$kc_source" rev-parse HEAD)"
git -C "$kc_source" push -q origin main
kc_upgrade() { printf '%s\n' 'fixture-token-abcdefghijklmnopqrstuvwxyz' | "$kc_broker" knowledge-contract-scrutator kc-upgrade "$kc_next"; }
if ! kc_upgrade >"${fixture_dir}/kc-upgrade-success.out" 2>&1; then
  sed -n '1,35p' "${fixture_dir}/kc-upgrade-success.out" >&2; exit 1
fi
grep -Fq "KC_PROJECT_UPGRADE_PASS project=knowledge-contract-scrutator" "${fixture_dir}/kc-upgrade-success.out" || exit 1
[[ "$(git -C "$kc_dir" rev-parse HEAD)" == "$kc_next" ]] || exit 1
echo 'PASS: kc_upgrade_pins_new_main_without_shared_compose'

printf '%s\n' '# next' >>"$kc_source/deploy/knowledge-contract-scrutator/compose.yml"
git -C "$kc_source" add deploy/knowledge-contract-scrutator/compose.yml
git -C "$kc_source" -c user.email=t@example.invalid -c user.name=t commit -qm next
kc_next="$(git -C "$kc_source" rev-parse HEAD)"
git -C "$kc_source" push -q origin main
export FAKE_KC_FAIL_UPGRADE_HEALTH=1
rm -f "$fake_docker_state/kc-up-count"
if kc_upgrade >"${fixture_dir}/kc-upgrade-rollback.out" 2>&1; then
  echo 'FAIL: unhealthy upgraded project accepted' >&2; exit 1
fi
grep -Fq 'KC_PROJECT_UPGRADE_ROLLBACK_PASS' "${fixture_dir}/kc-upgrade-rollback.out" || exit 1
[[ "$(git -C "$kc_dir" rev-parse HEAD)" == "$(git -C "$kc_source" rev-parse HEAD^)" ]] || exit 1
[[ -e "$fake_docker_state/kc-exists" ]] || exit 1
unset FAKE_KC_FAIL_UPGRADE_HEALTH
echo 'PASS: kc_upgrade_health_failure_restores_previous_checkout_and_project'

# KCP-0033: explicit reviewed image-pair set {old 16a4061f, new cc1e9828}. The image the checkout
# renders selects the pair; the running container must match one pair before an upgrade; the
# postcondition and the rollback use the selected pair; the project write opt-in may name only
# knowledge-contract.
kc_old_ref='scrutator-deploy:16a4061f0493fef5fc159e252cd793185ec2283c'
kc_old_id='sha256:ae4a4768ce83f34b3dc7c5b1620f836b8eafef86e32687b43a5c6a4eaa0c0c85'
kc_new_ref='scrutator-deploy:cc1e9828a89444c752faefec8fa39236d181465d'
kc_new_id='sha256:9adb3252b20ddd5508f42fcb56fc2c28512b047d192cb545e40f31a5869e3b26'
export FAKE_KC_IMAGE_FROM_CHECKOUT=1
kc_commit_image() {
  printf '%s\n' "# image=$1" >>"$kc_source/deploy/knowledge-contract-scrutator/compose.yml"
  git -C "$kc_source" add deploy/knowledge-contract-scrutator/compose.yml
  git -C "$kc_source" -c user.email=t@example.invalid -c user.name=t commit -qm "image $1"
  git -C "$kc_source" push -q origin main
  kc_head="$(git -C "$kc_source" rev-parse HEAD)"
  kc_next="$kc_head"
}
kc_set_config() { # edit the rendered Compose JSON: image, or an env var (value __unset__ removes it)
  python3 - "$fake_docker_state/kc-config.json" "$1" "$2" <<'PY'
import json, sys
p, key, value = sys.argv[1:4]
x = json.load(open(p))
svc = x["services"]["scrutator"]
if key == "image":
    svc["image"] = value
elif value == "__unset__":
    svc["environment"].pop(key, None)
else:
    svc["environment"][key] = value
json.dump(x, open(p, "w"))
PY
}
kc_fresh() { "$kc_broker" knowledge-contract-scrutator kc-stop >/dev/null 2>&1 || true; rm -rf -- "$kc_dir"; }

# New pair accepted on a fresh install and reported with the NEW image id.
kc_fresh
kc_commit_image "$kc_new_ref"; kc_set_config image "$kc_new_ref"
if ! kc_run >"${fixture_dir}/kc-pair-new.out" 2>&1; then sed -n '1,30p' "${fixture_dir}/kc-pair-new.out" >&2; echo 'FAIL: new pair refused' >&2; exit 1; fi
grep -Fq "image=${kc_new_id}" "${fixture_dir}/kc-pair-new.out" || { echo 'FAIL: new pair id not reported' >&2; exit 1; }
echo 'PASS: kc_new_image_pair_accepted'

# An image outside the set is refused before recreation (contract check).
kc_fresh
kc_foreign='scrutator-deploy:ffffffffffffffffffffffffffffffffffffffff'
kc_commit_image "$kc_foreign"; kc_set_config image "$kc_foreign"
if kc_run >"${fixture_dir}/kc-pair-foreign.out" 2>&1; then echo 'FAIL: foreign image accepted' >&2; exit 1; fi
grep -Fq 'Compose isolation contract failed' "${fixture_dir}/kc-pair-foreign.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
echo 'PASS: kc_image_outside_pair_set_refused'

# Contract JSON in the set but the rendered image is not: the pair selector refuses.
kc_fresh
kc_set_config image "$kc_new_ref"
if kc_run >"${fixture_dir}/kc-pair-rendered-foreign.out" 2>&1; then echo 'FAIL: rendered foreign image accepted' >&2; exit 1; fi
grep -Fq 'project Compose image reference mismatch' "${fixture_dir}/kc-pair-rendered-foreign.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
echo 'PASS: kc_rendered_image_outside_pair_set_refused'

# Write opt-in namespace: another namespace and the empty string are refused; the exact one and absence pass.
kc_fresh
kc_commit_image "$kc_new_ref"; kc_set_config image "$kc_new_ref"
kc_set_config SCRUTATOR_PROJECT_WRITE_NAMESPACE shared-tenant
if kc_run >"${fixture_dir}/kc-ns-other.out" 2>&1; then echo 'FAIL: other write namespace accepted' >&2; exit 1; fi
grep -Fq 'Compose isolation contract failed' "${fixture_dir}/kc-ns-other.out" || exit 1
[[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
echo 'PASS: kc_write_namespace_other_than_knowledge_contract_refused'
kc_set_config SCRUTATOR_PROJECT_WRITE_NAMESPACE ''
if kc_run >"${fixture_dir}/kc-ns-empty.out" 2>&1; then echo 'FAIL: empty write namespace accepted' >&2; exit 1; fi
echo 'PASS: kc_write_namespace_empty_string_refused'
kc_set_config SCRUTATOR_PROJECT_WRITE_NAMESPACE knowledge-contract
kc_fresh
if ! kc_run >"${fixture_dir}/kc-ns-ok.out" 2>&1; then sed -n '1,30p' "${fixture_dir}/kc-ns-ok.out" >&2; echo 'FAIL: exact write namespace refused' >&2; exit 1; fi
echo 'PASS: kc_write_namespace_knowledge_contract_accepted'
kc_set_config SCRUTATOR_PROJECT_WRITE_NAMESPACE __unset__
kc_fresh
if ! kc_run >"${fixture_dir}/kc-ns-absent.out" 2>&1; then echo 'FAIL: absent write namespace refused' >&2; exit 1; fi
echo 'PASS: kc_write_namespace_absent_accepted'

# KCP-0035 embedding contract: each governed key is absent or exactly the reviewed value.
kc_embed_refused() { # <name> <key> <value>
  kc_set_config "$2" "$3"
  kc_fresh
  if kc_run >"${fixture_dir}/kc-embed-$1.out" 2>&1; then echo "FAIL: ${1} accepted" >&2; exit 1; fi
  grep -Fq 'Compose isolation contract failed' "${fixture_dir}/kc-embed-$1.out" || { echo "FAIL: ${1} not refused by the contract" >&2; exit 1; }
  [[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
  kc_set_config "$2" __unset__
  echo "PASS: kc_embedding_${1}_refused"
}
kc_set_config SCRUTATOR_EMBEDDING_API_URL http://100.90.7.20:8300
kc_set_config SCRUTATOR_EMBEDDING_DENSE_SPARSE_ENABLED true
kc_set_config SCRUTATOR_EMBEDDING_TIMEOUT 300
kc_fresh
if ! kc_run >"${fixture_dir}/kc-embed-ok.out" 2>&1; then sed -n '1,30p' "${fixture_dir}/kc-embed-ok.out" >&2; echo 'FAIL: exact embedding env refused' >&2; exit 1; fi
echo 'PASS: kc_embedding_exact_values_accepted'
kc_embed_refused url_localhost SCRUTATOR_EMBEDDING_API_URL http://localhost:8300
kc_embed_refused url_other_host SCRUTATOR_EMBEDDING_API_URL http://100.90.7.21:8300
kc_embed_refused url_empty SCRUTATOR_EMBEDDING_API_URL ''
kc_embed_refused url_trailing_slash SCRUTATOR_EMBEDDING_API_URL http://100.90.7.20:8300/
kc_embed_refused dense_sparse_false SCRUTATOR_EMBEDDING_DENSE_SPARSE_ENABLED false
kc_embed_refused dense_sparse_capitalised SCRUTATOR_EMBEDDING_DENSE_SPARSE_ENABLED True
kc_embed_refused dense_sparse_empty SCRUTATOR_EMBEDDING_DENSE_SPARSE_ENABLED ''
kc_embed_refused timeout_30 SCRUTATOR_EMBEDDING_TIMEOUT 30
kc_embed_refused timeout_empty SCRUTATOR_EMBEDDING_TIMEOUT ''
kc_embed_refused timeout_padded SCRUTATOR_EMBEDDING_TIMEOUT ' 300'
# Look-alike keys that differ only by case could be read by a case-insensitive settings loader.
kc_embed_refused lowercase_url_key scrutator_embedding_api_url http://100.90.7.20:8300
kc_embed_refused mixedcase_timeout_key Scrutator_Embedding_Timeout 300
kc_embed_refused lowercase_write_namespace_key scrutator_project_write_namespace knowledge-contract
kc_embed_refused lowercase_database_url_key scrutator_database_url postgres://x
kc_set_config SCRUTATOR_EMBEDDING_API_URL __unset__
kc_set_config SCRUTATOR_EMBEDDING_DENSE_SPARSE_ENABLED __unset__
kc_set_config SCRUTATOR_EMBEDDING_TIMEOUT __unset__
kc_fresh
if ! kc_run >"${fixture_dir}/kc-embed-absent.out" 2>&1; then echo 'FAIL: absent embedding env refused (old pair rollback path)' >&2; exit 1; fi
echo 'PASS: kc_embedding_env_absent_accepted'

# KCP-0017 step 2: exactly two reviewed network/introspection variants are accepted.
#   PUBLIC   = default network only + the public introspection URL (today's render).
#   INTERNAL = default network + external network key "auth-arcana-ai" named auth-arcana-ai_default,
#              attached to the service, + exactly the internal introspection URL.
kc_edit() { # <python statements over x (config), svc, env, nets>
  python3 - "$fake_docker_state/kc-config.json" "$1" <<'PY'
import json, sys
p, code = sys.argv[1:3]
x = json.load(open(p))
svc = x["services"]["scrutator"]
env = svc["environment"]
nets = x["networks"]
exec(code)
json.dump(x, open(p, "w"))
PY
}
kc_public_url='https://auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect'
kc_internal_url='http://auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect'
# The two snapshots below are the real `docker compose config --format json` renders (Compose v5.6.0)
# of contract-place-api main (PUBLIC) and of PR #9 at 7830a863 (INTERNAL), with the fixture DSN.
cat >"${fixture_dir}/kc-config-public.json" <<'JSON'
{"name":"knowledge-contract-scrutator","networks":{"default":{"name":"knowledge-contract-scrutator_default","ipam":{}}},"services":{"scrutator":{"restart":"unless-stopped","container_name":"knowledge-contract-scrutator-scrutator-1","command":null,"entrypoint":null,"environment":{"SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL":"https://auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect","SCRUTATOR_AUTH_ENFORCE":"true","SCRUTATOR_AUTH_SERVICE_AUDIENCE":"urn:arcanada:scrutator:knowledge-contract","SCRUTATOR_AUTH_SERVICE_SCOPE":"kb:knowledge-contract.read","SCRUTATOR_DATABASE_URL":"postgresql://kc_scrutator_app:fixture@100.97.136.74:5432/knowledge_contract","SCRUTATOR_EMBEDDING_API_URL":"http://100.90.7.20:8300","SCRUTATOR_EMBEDDING_DENSE_SPARSE_ENABLED":"true","SCRUTATOR_EMBEDDING_TIMEOUT":"300","SCRUTATOR_FEEDER_NAMESPACES":"knowledge-contract","SCRUTATOR_HOST":"0.0.0.0","SCRUTATOR_PORT":"8310"},"image":"scrutator-deploy:cc1e9828a89444c752faefec8fa39236d181465d","networks":{"default":null},"healthcheck":{"test":["CMD","curl","--fail","--silent","http://127.0.0.1:8310/health"],"timeout":"5s","interval":"30s","retries":3},"ports":[{"mode":"ingress","host_ip":"127.0.0.1","target":8310,"published":"8311","protocol":"tcp"}]}}}
JSON
cat >"${fixture_dir}/kc-config-internal.json" <<'JSON'
{"name":"knowledge-contract-scrutator","networks":{"auth-arcana-ai":{"name":"auth-arcana-ai_default","ipam":{},"external":true},"default":{"name":"knowledge-contract-scrutator_default","ipam":{}}},"services":{"scrutator":{"restart":"unless-stopped","container_name":"knowledge-contract-scrutator-scrutator-1","command":null,"entrypoint":null,"environment":{"SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL":"http://auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect","SCRUTATOR_AUTH_ENFORCE":"true","SCRUTATOR_AUTH_SERVICE_AUDIENCE":"urn:arcanada:scrutator:knowledge-contract","SCRUTATOR_AUTH_SERVICE_SCOPE":"kb:knowledge-contract.read","SCRUTATOR_DATABASE_URL":"postgresql://kc_scrutator_app:fixture@100.97.136.74:5432/knowledge_contract","SCRUTATOR_EMBEDDING_API_URL":"http://100.90.7.20:8300","SCRUTATOR_EMBEDDING_DENSE_SPARSE_ENABLED":"true","SCRUTATOR_EMBEDDING_TIMEOUT":"300","SCRUTATOR_FEEDER_NAMESPACES":"knowledge-contract","SCRUTATOR_HOST":"0.0.0.0","SCRUTATOR_PORT":"8310"},"image":"scrutator-deploy:cc1e9828a89444c752faefec8fa39236d181465d","networks":{"auth-arcana-ai":null,"default":null},"healthcheck":{"test":["CMD","curl","--fail","--silent","http://127.0.0.1:8310/health"],"timeout":"5s","interval":"30s","retries":3},"ports":[{"mode":"ingress","host_ip":"127.0.0.1","target":8310,"published":"8311","protocol":"tcp"}]}}}
JSON
kc_use() { cp -- "${fixture_dir}/kc-config-$1.json" "$fake_docker_state/kc-config.json"; }
kc_route_refused() { # <name> <python edit applied on top of the exact INTERNAL variant>
  kc_use internal
  kc_edit "$2"
  kc_fresh
  if kc_run >"${fixture_dir}/kc-route-$1.out" 2>&1; then echo "FAIL: route variant ${1} accepted" >&2; exit 1; fi
  grep -Fq 'Compose isolation contract failed' "${fixture_dir}/kc-route-$1.out" || { echo "FAIL: route variant ${1} not refused by the contract" >&2; exit 1; }
  [[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
  kc_use public
  echo "PASS: kc_route_${1}_refused"
}
kc_use public
kc_fresh
if ! kc_run >"${fixture_dir}/kc-route-public.out" 2>&1; then sed -n '1,30p' "${fixture_dir}/kc-route-public.out" >&2; echo 'FAIL: PUBLIC variant refused' >&2; exit 1; fi
grep -Fq 'KC_PROJECT_DEPLOY_PASS' "${fixture_dir}/kc-route-public.out" || exit 1
echo 'PASS: kc_route_public_variant_accepted'
kc_use internal
kc_fresh
if ! kc_run >"${fixture_dir}/kc-route-internal.out" 2>&1; then sed -n '1,30p' "${fixture_dir}/kc-route-internal.out" >&2; echo 'FAIL: INTERNAL variant refused' >&2; exit 1; fi
grep -Fq 'KC_PROJECT_DEPLOY_PASS' "${fixture_dir}/kc-route-internal.out" || exit 1
echo 'PASS: kc_route_internal_variant_accepted'
kc_use public
# The URL and the network only together.
kc_route_refused internal_url_without_network "nets.pop('auth-arcana-ai'); svc['networks'] = {'default': None}"
kc_route_refused network_with_public_url "env['SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL'] = '${kc_public_url}'"
kc_route_refused network_declared_not_attached "svc['networks'] = {'default': None}"
kc_route_refused network_attached_without_default "svc['networks'] = {'auth-arcana-ai': None}"
# Any other external network, key, name or attribute.
kc_route_refused other_external_name "nets['auth-arcana-ai']['name'] = 'auth-arcana-prod_default'"
kc_route_refused lookalike_name_suffix "nets['auth-arcana-ai']['name'] = 'auth-arcana-ai_default2'"
kc_route_refused lookalike_name_case "nets['auth-arcana-ai']['name'] = 'Auth-arcana-ai_default'"
kc_route_refused lookalike_name_space "nets['auth-arcana-ai']['name'] = 'auth-arcana-ai_default '"
kc_route_refused other_network_key "nets['auth'] = nets.pop('auth-arcana-ai'); svc['networks'] = {'auth': None, 'default': None}"
kc_route_refused not_external "nets['auth-arcana-ai'].pop('external')"
kc_route_refused external_false "nets['auth-arcana-ai']['external'] = False"
kc_route_refused external_string "nets['auth-arcana-ai']['external'] = 'true'"
kc_route_refused network_driver "nets['auth-arcana-ai']['driver'] = 'bridge'"
kc_route_refused network_ipam_config "nets['auth-arcana-ai']['ipam'] = {'config': [{'subnet': '172.30.0.0/16'}]}"
kc_route_refused third_network "nets['other'] = {'name': 'other_default', 'ipam': {}, 'external': True}; svc['networks']['other'] = None"
kc_route_refused extra_service_attachment "svc['networks']['other'] = None"
kc_route_refused attachment_aliases "svc['networks']['auth-arcana-ai'] = {'aliases': ['scrutator']}"
kc_route_refused attachment_static_ip "svc['networks']['auth-arcana-ai'] = {'ipv4_address': '172.30.0.9'}"
kc_route_refused links "svc['links'] = ['auth-arcana-ai-app-1']"
kc_route_refused external_links "svc['external_links'] = ['auth-arcana-ai-app-1']"
kc_route_refused network_mode_host "svc['network_mode'] = 'host'; svc.pop('networks')"
# Any other internal URL: scheme, host, port, path, userinfo, query, fragment, look-alikes.
kc_route_url_refused() { kc_route_refused "url_$1" "env['SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL'] = '$2'"; }
kc_route_url_refused https_scheme 'https://auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused other_container 'http://auth-arcana-prod-app-1:3200/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused host_port 'http://auth-arcana-ai-app-1:3220/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused no_port 'http://auth-arcana-ai-app-1/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused loopback 'http://127.0.0.1:3220/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused host_gateway 'http://host.docker.internal:3220/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused other_path 'http://auth-arcana-ai-app-1:3200/api/v1/api-keys/introspect'
kc_route_url_refused trailing_slash 'http://auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect/'
kc_route_url_refused userinfo 'http://user:pass@auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused query 'http://auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect?x=1'
kc_route_url_refused fragment 'http://auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect#x'
kc_route_url_refused uppercase_host 'http://AUTH-ARCANA-AI-APP-1:3200/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused lookalike_host 'http://auth-arcana-ai-app-1.example.invalid:3200/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused lookalike_host_suffix 'http://auth-arcana-ai-app-10:3200/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused padded ' http://auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect'
kc_route_url_refused empty ''
kc_use public
# On top of the PUBLIC variant: the service may attach only to the default network.
kc_public_refused() { # <name> <python edit applied on top of the exact PUBLIC variant>
  kc_use public
  kc_edit "$2"
  kc_fresh
  if kc_run >"${fixture_dir}/kc-route-public-$1.out" 2>&1; then echo "FAIL: public variant ${1} accepted" >&2; exit 1; fi
  grep -Fq 'Compose isolation contract failed' "${fixture_dir}/kc-route-public-$1.out" || { echo "FAIL: public variant ${1} not refused by the contract" >&2; exit 1; }
  [[ ! -e "$fake_docker_state/kc-exists" ]] || exit 1
  kc_use public
  echo "PASS: kc_route_public_${1}_refused"
}
kc_public_refused undeclared_attachment "svc['networks']['auth-arcana-ai'] = None"
kc_public_refused default_aliases "svc['networks']['default'] = {'aliases': ['scrutator']}"
kc_public_refused internal_host_on_public_scheme "env['SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL'] = 'https://auth-arcana-ai-app-1/api/v1/api-keys/knowledge-contract/introspect'"
# Third network declared but not attached: refused over both variants.
kc_route_refused third_network_declared_not_attached "nets['other'] = {'name': 'other_default', 'ipam': {}, 'external': True}"
kc_public_refused third_network_declared_not_attached "nets['other'] = {'name': 'other_default', 'ipam': {}, 'external': True}"
# PUBLIC URL is an exact string too.
kc_public_url_refused() { kc_public_refused "url_$1" "env['SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL'] = '$2'"; }
kc_public_url_refused port_443 'https://auth.arcanada.ai:443/api/v1/api-keys/knowledge-contract/introspect'
kc_public_url_refused userinfo 'https://user:pass@auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect'
kc_public_url_refused query 'https://auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect?x=1'
kc_public_url_refused fragment 'https://auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect#x'
kc_public_url_refused trailing_slash 'https://auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect/'
kc_public_url_refused uppercase_host 'https://AUTH.ARCANADA.AI/api/v1/api-keys/knowledge-contract/introspect'
kc_public_url_refused http_scheme 'http://auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect'
# Name resolution, kernel network settings and egress environment of the service (review finding 1):
# refused over BOTH variants. Compose renders env_file values into environment, so these cover env_file.
kc_both_refused() { kc_route_refused "$1" "$2"; kc_public_refused "$1" "$2"; }
kc_both_refused extra_hosts_list "svc['extra_hosts'] = ['auth-arcana-ai-app-1=203.0.113.5']"
kc_both_refused extra_hosts_mapping "svc['extra_hosts'] = {'auth.arcanada.ai': '203.0.113.5'}"
kc_both_refused dns "svc['dns'] = ['203.0.113.53']"
kc_both_refused dns_search "svc['dns_search'] = ['example.invalid']"
kc_both_refused dns_opt "svc['dns_opt'] = ['ndots:5']"
kc_both_refused sysctls "svc['sysctls'] = {'net.ipv4.ip_forward': '1'}"
kc_both_refused cap_add_net_admin "svc['cap_add'] = ['NET_ADMIN']"
kc_both_refused privileged "svc['privileged'] = True"
kc_public_refused network_mode_host "svc['network_mode'] = 'host'; svc.pop('networks')"
for kc_egress_key in HTTP_PROXY http_proxy Https_Proxy HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy WS_PROXY wss_proxy SSL_CERT_FILE ssl_cert_dir SSLKEYLOGFILE; do
  kc_both_refused "env_${kc_egress_key}" "env['${kc_egress_key}'] = 'http://203.0.113.7:3128'"
done
# Re-review of 4523cd4a: the service is an ALLOWLIST. Even empty forms of unlisted keys and any
# unlisted environment key are refused, over both variants.
kc_both_refused empty_extra_hosts "svc['extra_hosts'] = []"
kc_both_refused empty_dns "svc['dns'] = []"
# Resolver, loader, CA, runtime and harmless-looking environment keys: none is listed, all refused.
for kc_env_key in LOCALDOMAIN RES_OPTIONS HOSTALIASES OPENSSL_CONF LD_PRELOAD LD_LIBRARY_PATH PYTHONPATH PYTHONHOME PYTHONSTARTUP REQUESTS_CA_BUNDLE CURL_CA_BUNDLE NODE_OPTIONS TZ SCRUTATOR_PROXY_NOTE SCRUTATOR_AUTH_ARCANA_JWKS_URL; do
  kc_both_refused "env_${kc_env_key}" "env['${kc_env_key}'] = 'x'"
done
kc_both_refused env_resolver_pair "env['RES_OPTIONS'] = 'ndots:1'; env['LOCALDOMAIN'] = 'attacker.example'"
# Bare environment forms (`- KEY` renders as null) and non-string values are refused.
kc_both_refused env_bare_listed_key "env['SCRUTATOR_PROJECT_WRITE_NAMESPACE'] = None"
kc_both_refused env_bare_unlisted_key "env['LOCALDOMAIN'] = None"
kc_both_refused env_port_integer "env['SCRUTATOR_PORT'] = 8310"
kc_both_refused env_enforce_capitalised "env['SCRUTATOR_AUTH_ENFORCE'] = 'True'"
kc_both_refused env_missing_required "env.pop('SCRUTATOR_FEEDER_NAMESPACES')"
# Code execution and container shape: not listed, so refused.
kc_both_refused command "svc['command'] = ['sh', '-c', 'echo 203.0.113.5 auth-arcana-ai-app-1 >> /etc/hosts; exec uvicorn scrutator.health:app']"
kc_both_refused entrypoint "svc['entrypoint'] = ['sh', '-c']"
kc_both_refused user "svc['user'] = '0:0'"
kc_both_refused tmpfs "svc['tmpfs'] = ['/etc']"
kc_both_refused post_start "svc['post_start'] = [{'command': ['sh', '-c', 'true']}]"
kc_both_refused uts "svc['uts'] = 'host'"
kc_both_refused userns_mode "svc['userns_mode'] = 'host'"
kc_both_refused runtime "svc['runtime'] = 'runc'"
kc_both_refused ulimits "svc['ulimits'] = {'nofile': 1024}"
kc_both_refused init "svc['init'] = True"
kc_both_refused labels "svc['labels'] = {'a': 'b'}"
kc_both_refused env_file_key "svc['env_file'] = ['/etc/other.env']"
kc_both_refused working_dir "svc['working_dir'] = '/tmp'"
# Healthcheck and restart are pinned to the exact rendered values.
kc_both_refused healthcheck_cmd_shell "svc['healthcheck']['test'] = ['CMD-SHELL', 'echo 203.0.113.5 auth-arcana-ai-app-1 >> /etc/hosts']"
kc_both_refused healthcheck_other_url "svc['healthcheck']['test'] = ['CMD', 'curl', '--fail', '--silent', 'http://127.0.0.1:8310/v1/stats']"
kc_both_refused healthcheck_interval "svc['healthcheck']['interval'] = '1s'"
kc_both_refused healthcheck_extra_key "svc['healthcheck']['start_period'] = '5s'"
kc_both_refused healthcheck_disabled "svc['healthcheck'] = {'disable': True}"
kc_both_refused healthcheck_absent "svc.pop('healthcheck')"
kc_both_refused restart_always "svc['restart'] = 'always'"
kc_both_refused command_empty_list "svc['command'] = []"
# The real renders stay accepted with the listed optional keys at their pinned values.
kc_use internal
kc_edit "env['SCRUTATOR_PROJECT_WRITE_NAMESPACE'] = 'knowledge-contract'"
kc_fresh
if ! kc_run >"${fixture_dir}/kc-route-internal-optional.out" 2>&1; then sed -n '1,30p' "${fixture_dir}/kc-route-internal-optional.out" >&2; echo 'FAIL: INTERNAL with the write namespace refused' >&2; exit 1; fi
kc_use public
echo 'PASS: kc_route_internal_with_write_namespace_accepted'

# Selector level (not the Compose contract): a ref that only starts with a reviewed ref is not in the set.
kc_selector_fn="$(sed -n '/^kc_pair_id_for_ref() {/,/^}/p' "$broker")"
[[ -n "$kc_selector_fn" ]] || { echo 'FAIL: selector function not found' >&2; exit 1; }
kc_selector() ( # <ref>; prints the pair id or exits 1
  KC_OLD_IMAGE_REF="$kc_old_ref"; KC_OLD_IMAGE_ID="$kc_old_id"; KC_NEW_IMAGE_REF="$kc_new_ref"; KC_NEW_IMAGE_ID="$kc_new_id"
  eval "$kc_selector_fn"
  kc_pair_id_for_ref "$1"
)
[[ "$(kc_selector "$kc_new_ref")" == "$kc_new_id" ]] || { echo 'FAIL: selector rejects the new ref' >&2; exit 1; }
[[ "$(kc_selector "$kc_old_ref")" == "$kc_old_id" ]] || { echo 'FAIL: selector rejects the old ref' >&2; exit 1; }
for kc_bad_ref in "${kc_new_ref}-x" "${kc_new_ref}x" "${kc_old_ref}-x" "x${kc_new_ref}" "${kc_new_ref%?}" "${kc_new_ref}"$'\n'"${kc_old_ref}" ''; do
  if kc_selector "$kc_bad_ref" >/dev/null 2>&1; then echo "FAIL: selector accepted a look-alike ref" >&2; exit 1; fi
done
echo 'PASS: kc_pair_selector_refuses_prefix_and_lookalike_refs'

# Upgrade old -> new succeeds, reports the new id, and leaves the new image running.
kc_fresh
kc_commit_image "$kc_old_ref"; kc_set_config image "$kc_old_ref"
if ! kc_run >"${fixture_dir}/kc-pair-base-old.out" 2>&1; then sed -n '1,30p' "${fixture_dir}/kc-pair-base-old.out" >&2; exit 1; fi
grep -Fq "$kc_old_id" "$fake_docker_state/kc-running-image" || exit 1
kc_commit_image "$kc_new_ref"
if ! kc_upgrade >"${fixture_dir}/kc-pair-upgrade.out" 2>&1; then sed -n '1,30p' "${fixture_dir}/kc-pair-upgrade.out" >&2; echo 'FAIL: old->new upgrade refused' >&2; exit 1; fi
grep -Fq "KC_PROJECT_UPGRADE_PASS project=knowledge-contract-scrutator image=${kc_new_id}" "${fixture_dir}/kc-pair-upgrade.out" || exit 1
grep -Fq "$kc_new_id" "$fake_docker_state/kc-running-image" || exit 1
echo 'PASS: kc_upgrade_old_to_new_pair'

# Failed readiness of the new image rolls back to the OLD pair (old checkout, old image id running).
kc_fresh
kc_commit_image "$kc_old_ref"; kc_set_config image "$kc_old_ref"
if ! kc_run >"${fixture_dir}/kc-pair-base-old2.out" 2>&1; then exit 1; fi
kc_commit_image "$kc_new_ref"
export FAKE_KC_FAIL_UPGRADE_HEALTH=1
rm -f "$fake_docker_state/kc-up-count"
if kc_upgrade >"${fixture_dir}/kc-pair-rollback.out" 2>&1; then echo 'FAIL: unhealthy new image accepted' >&2; exit 1; fi
unset FAKE_KC_FAIL_UPGRADE_HEALTH
grep -Fq 'KC_PROJECT_UPGRADE_ROLLBACK_PASS' "${fixture_dir}/kc-pair-rollback.out" || { sed -n '1,30p' "${fixture_dir}/kc-pair-rollback.out" >&2; exit 1; }
grep -Fq "$kc_old_id" "$fake_docker_state/kc-running-image" || { echo 'FAIL: rollback did not restore the old image' >&2; exit 1; }
echo 'PASS: kc_upgrade_failure_rolls_back_to_old_pair'

# A running container outside both pairs blocks an upgrade.
printf '%s\n' 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' >"$fake_docker_state/kc-running-image"
kc_commit_image "$kc_new_ref"
if kc_upgrade >"${fixture_dir}/kc-pair-running-foreign.out" 2>&1; then echo 'FAIL: foreign running image upgraded' >&2; exit 1; fi
grep -Fq 'wrong image' "${fixture_dir}/kc-pair-running-foreign.out" || exit 1
echo 'PASS: kc_running_container_outside_pair_set_blocks_upgrade'
unset FAKE_KC_IMAGE_FROM_CHECKOUT
