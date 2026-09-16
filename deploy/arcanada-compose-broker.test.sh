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

echo 'All aggregate readback broker cases passed.'
