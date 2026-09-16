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
mkdir -p "${state_root}/muneral/.git" "${state_root}/muneral/apps/api/scripts" \
  "${env_root}" "${bin_root}"
cp "$subject" "$broker"

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
# Report the variable the broker exported, so the test asserts the VALUE and
# not merely that the command was reached.
printf 'FAKE_DOCKER IMAGE_TAG=%s ARGV=%s\n' "${IMAGE_TAG:-<unset>}" "$*"
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

echo 'All aggregate readback broker cases passed.'
