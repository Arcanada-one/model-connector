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
cat >"$fake_docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# Report the variables the broker exported, so the tests assert the VALUE and
# not merely that the command was reached.
printf 'FAKE_DOCKER IMAGE_TAG=%s BUILD_SHA=%s ARGV=%s\n' \
  "${IMAGE_TAG:-<unset>}" "${BUILD_SHA:-<unset>}" "$*"
SH
chmod 0755 "$fake_docker"
sed -i -e "s#^readonly DOCKER=.*#readonly DOCKER='${fake_docker}'#" "$broker"

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
if grep -Fq 'FAKE_GIT_REACHED' \
  "${fixture_dir}/argana_sync_requires_a_fetch_credential.out"; then
  echo 'FAIL: sync reached git without demanding a credential' >&2
  exit 1
fi

echo 'All aggregate readback broker cases passed.'
