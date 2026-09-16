#!/usr/bin/env bash
# SEC-0028 — narrow root broker for compose-based deploys.
#
# Why this exists: the `arcana-prod` runner account was in the host `docker`
# group, which is root-equivalent, on the same host as the Control Arcana root
# deploy broker. The Control installer refuses to install its reviewed bundle
# while that is true, so no Control release can ship. Removing the group first
# requires every job that relied on it to have another way to deploy.
#
# The threat this actually closes: a broker that builds or runs compose content
# supplied by the runner grants the runner root, which relocates the problem
# rather than solving it. So the runner supplies NO content here. It names a
# service from a fixed allowlist and a commit SHA, and the broker refuses any
# SHA that is not already reachable from origin/main. Landing code on main is a
# reviewed path; that is the boundary being relied on, and it is stated so it
# can be argued with.
#
# The second thing it closes: container environment is code. A service whose
# env file the runner can write is a service whose container the runner
# controls, which is the same escalation wearing a smaller hat. Services listed
# in ENVFILE take their environment from a root-owned file, re-installed into
# the checkout as `.env` on every sync, mode 0600 root:root.
#
# Every value the deploy depends on — the checked-out tree, BUILD_SHA, the
# image digest a post-deploy check compares against — is derived by the broker
# from its own checkout, never accepted from the caller. A runner that could
# name the digest its deploy is verified against could pass verification while
# running something else.
#
# The one thing a caller may hand over is a fetch credential for a private
# repository, read from stdin and never from argv (argv is world-readable in
# /proc). It authenticates the fetch; it cannot redirect it, because the
# repository URL is compiled in. This is deliberately preferred over a
# long-lived deploy key on the host: the org disables deploy keys, and a
# job-scoped token that expires beats a file that does not.
set -euo pipefail
IFS=$'\n\t'
umask 022
readonly STATE_ROOT=/var/lib/arcanada-deploy
readonly ENV_ROOT=/etc/arcanada/deploy-env
readonly GIT=/usr/bin/git
readonly DOCKER=/usr/bin/docker
readonly PNPM=/usr/bin/pnpm
readonly NODE=/usr/bin/node

# ---------------------------------------------------------------------------
# Service table. Edit here, re-install, never parameterise.
# ---------------------------------------------------------------------------
#
# SEC-0063 (2026-08-18): the copy of this script on arcana-agents carries a
# DIFFERENT service table, and that is deliberate — not drift to reconcile. A
# service belongs in the table of the host whose containers and volumes it
# actually has. Registering a service on a host it does not run on would let a
# deploy landing there build a SECOND, EMPTY stack and report success.
#
# Related trap: the runners arcana-prod-replacement / arcana-prod-ci-replacement
# live on arcana-agents but still advertise the label "arcana-prod" from an old
# outage stand-in, so a job targeting that label may land on either machine.
# This host also advertises "arcana-prod-host", which resolves to exactly one
# machine; deploys that must be deterministic should target that.
declare -rA REPOS=(
  [model-connector]='https://github.com/Arcanada-one/model-connector.git'
  [muneral]='https://github.com/Arcanada-one/muneral.git'
  [opsbot]='https://github.com/Arcanada-one/opsbot.git'
  [transcribator-api]='https://github.com/Arcanada-one/transcribator-api.git'
  [legal-arcana]='https://github.com/Arcanada-one/legal-arcana.git'
  # SEC-0063: the INFRA-0376 consumer inventory classified this service
  # `migrate-broker` on 2026-07-30 and the conversion was then missed when
  # that task closed. Its deploy has failed at `permission denied ...
  # /var/run/docker.sock` on every push to main since the group was retired
  # — loudly, which is why nothing silently rotted. The repository is
  # PUBLIC, so it deliberately gets no AUTH row: cmd_sync would then demand
  # a credential on stdin and die on the empty read.
  [arcanada-assistant]='https://github.com/Arcanada-one/arcanada-assistant.git'
  # INFRA-0417: verdicus-api deployed by having the RUNNER hold the docker
  # group and run `docker compose` itself. SEC-0028 retired that group on
  # 2026-08-12 and the deploy has failed on every push to main since, with
  # `permission denied ... /var/run/docker.sock` — the container has been
  # serving a 12 August image while main moved on. Converting it to the broker
  # is what actually fixes that; moving it to another machine only relocates a
  # deploy that does not work.
  [verdicus]='https://github.com/Arcanada-one/verdicus.git'
)
declare -rA COMPOSE=(
  [model-connector]='deploy/stt-whisper/docker-compose.yml'
  [muneral]='docker-compose.prod.yml'
  [opsbot]='docker-compose.prod.yml'
  [transcribator-api]='docker-compose.prod.yml'
  [legal-arcana]='docker-compose.yml'
  [arcanada-assistant]='docker-compose.yml'
  [verdicus]='docker-compose.prod.yml'
)
# Private repositories whose fetch needs a credential on stdin.
declare -rA AUTH=(
  [opsbot]='github-token'
  [transcribator-api]='github-token'
  [legal-arcana]='github-token'
  [verdicus]='github-token'
)
# Pin the compose project name. Unset means Compose derives it from the
# checkout directory, which is what the whisper stack has always done —
# naming it retroactively would orphan its containers.
declare -rA PROJECT=(
  [muneral]='muneral'
  [opsbot]='opsbot'
  [transcribator-api]='transcribator-api'
  [legal-arcana]='legal-arcana'
  # Pinned to the name the ALREADY-RUNNING stack carries
  # (com.docker.compose.project=arcanada-assistant). Compose namespaces a
  # named volume as <project>_<volume>, so a project name that did not match
  # would not adopt arcanada-assistant_postgres-data — it would create an
  # empty volume beside it, start a second stack that fights for the same
  # published ports, and serve an empty database. The basename of the broker
  # checkout happens to derive the same name; this pin is here so that
  # coincidence is not what the database depends on.
  [arcanada-assistant]='arcanada-assistant'
  # The running stack carries com.docker.compose.project=verdicus-api, but the
  # broker's checkout directory is named after the REPOSITORY (`verdicus`), so
  # the derived name would differ by those four characters. Compose would then
  # treat the existing container as none of its business, start a second one
  # beside it, and both would fight for 127.0.0.1:3301 — one of them losing
  # silently. Pinned, so the identity does not depend on a directory name.
  [verdicus]='verdicus-api'
)
# Root-owned environment file. A bare name resolves under ENV_ROOT; an absolute
# path is used as given, so a service whose env is already root-owned somewhere
# operators maintain is referenced rather than copied — a duplicated secret file
# that silently drifts is worse than an unusual path.
declare -rA ENVFILE=(
  [muneral]='muneral.env'
  [opsbot]='opsbot.env'
  [transcribator-api]='/opt/transcribator/.env'
  [legal-arcana]='legal-arcana.env'
  [arcanada-assistant]='arcanada-assistant.env'
  [verdicus]='verdicus.env'
)
# A release script inside the checkout that already encapsulates the whole
# deploy. Running it as root is the same trust boundary the broker already
# relies on everywhere else — its content is reachable from origin/main, and
# `docker compose build` executes that content as root regardless. What changes
# is that the runner no longer supplies the tree it runs from, nor the
# environment it runs with.
declare -rA SCRIPT=(
  [legal-arcana]='deploy/deploy.sh'
)
# Schema-migration recipe run before `up`.
declare -rA MIGRATE=(
  [muneral]='pnpm-prisma'
  [transcribator-api]='compose-run-prisma'
)
# Services whose compose file interpolates BUILD_SHA. The broker supplies it
# from its own checkout HEAD.
declare -rA BUILDSHA=(
  [transcribator-api]='yes'
)
# Services whose compose file interpolates IMAGE_TAG to select a PRE-BUILT
# image from a registry. The broker supplies it from its own checkout HEAD, so
# the deployed image is pinned to the commit that triggered the deploy rather
# than to a floating `latest`.
declare -rA IMAGETAG=(
  [verdicus]='yes'
)
# Locally built image name for tag rotation and digest resolution.
declare -rA IMAGE=(
  [transcribator-api]='transcribator-api'
)
# Services to force-recreate on rollback.
declare -rA ROLLBACK_SERVICES=(
  [transcribator-api]='redis api bot worker'
)
# Post-deploy verification script inside the checkout.
declare -rA VERIFY=(
  [transcribator-api]='scripts/post-deploy-verify.sh'
)
# Single container to inspect for freshness / smoke checks.
declare -rA CONTAINER=(
  [opsbot]='opsbot'
  [arcanada-assistant]='arcanada-assistant-assistant-1'
)
declare -rA MAXAGE=(
  [opsbot]='300'
  # The assistant image builds a pnpm workspace and takes longer than opsbot;
  # 600s still fails a deploy that recreated nothing.
  [arcanada-assistant]='600'
)
# Fixed argv for the module-load smoke check. Compiled in, so the word
# splitting below is on a constant, not on caller input.
declare -rA SMOKE=(
  [opsbot]='node --check /app/dist/main.js'
)
# Container environment keys a caller may read back. Everything else in the
# container environment stays invisible, because most of it is secret.
declare -rA ENVKEYS=(
  [opsbot]='OPSBOT_HEARTBEAT_ENABLED'
)
# Fixed, aggregate-only production readback helpers. The caller can select only
# a service and this verb; SQL, connection material, argv and output shape stay
# inside the reviewed service checkout.
declare -rA AGGREGATE_READBACK=(
  [muneral]='apps/api/scripts/semantic-aggregate-readback.mjs'
)

die() { printf 'arcanada-compose-broker: %s\n' "$1" >&2; exit 1; }

validate_service() {
  local svc="$1"
  [[ "$svc" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || die 'invalid service name'
  [[ -n "${REPOS[$svc]+set}" ]] || die "service not in allowlist: $svc"
  printf '%s' "$svc"
}
validate_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die 'release sha must be 40 lowercase hex'
  printf '%s' "$1"
}
checkout_dir() { printf '%s/%s' "$STATE_ROOT" "$1"; }
head_sha() { "$GIT" -C "$(checkout_dir "$1")" rev-parse HEAD; }

env_path() {
  local svc="$1"
  local v="${ENVFILE[$svc]}"
  if [[ "$v" == /* ]]; then printf '%s' "$v"; else printf '%s/%s' "$ENV_ROOT" "$v"; fi
}

# Build the compose argv for a service. Kept in one place so every action runs
# against the same project and file; a divergence here would silently create a
# second stack alongside the live one. It writes a global rather than printing,
# because a `die` inside a command substitution or process substitution only
# kills the subshell — the caller would carry on with an empty argv and fail
# somewhere less honest.
COMPOSE_ARGV=()
set_compose_argv() {
  local svc="$1" file
  file="$(checkout_dir "$svc")/${COMPOSE[$svc]}"
  [[ -f "$file" && ! -L "$file" ]] || die 'compose file missing or not a regular file'
  if [[ -n "${PROJECT[$svc]+set}" ]]; then
    COMPOSE_ARGV=(compose -p "${PROJECT[$svc]}" -f "$file")
  else
    COMPOSE_ARGV=(compose -f "$file")
  fi
}

# BUILD_SHA and IMAGE_TAG are exported here and nowhere else, from the checkout
# the broker controls, so a caller cannot label an image with a commit it is
# not built from, nor point a deploy at an image it did not produce.
#
# The two are not the same case. BUILD_SHA labels an image this host BUILDS;
# IMAGE_TAG selects a pre-built image this host PULLS. For a pulled image the
# tag is the entire identity of what gets deployed — leaving it unset would
# resolve `${IMAGE_TAG:-latest}` to a floating tag, and the deploy would no
# longer be pinned to the commit that triggered it.
compose_env() {
  local svc="$1"
  if [[ -n "${BUILDSHA[$svc]+set}" ]]; then
    BUILD_SHA="$(head_sha "$svc")"
    export BUILD_SHA
  fi
  if [[ -n "${IMAGETAG[$svc]+set}" ]]; then
    IMAGE_TAG="$(head_sha "$svc")"
    export IMAGE_TAG
  fi
}

require_checkout() {
  [[ -d "$(checkout_dir "$1")/.git" ]] || die 'checkout missing — sync first'
}

ROOT_ENV_PATH=''
set_root_env_path() {
  local svc="$1" src
  [[ -n "${ENVFILE[$svc]+set}" ]] || return 0
  src="$(env_path "$svc")"
  [[ -f "$src" && ! -L "$src" ]] || die "root-owned env file missing: $src"
  [[ "$(stat -c '%U' -- "$src")" == 'root' ]] || die "env file is not root-owned: $src"
  ROOT_ENV_PATH="$src"
}

install_env() {
  local svc="$1" dir
  [[ -n "${ENVFILE[$svc]+set}" ]] || return 0
  dir="$(checkout_dir "$svc")"
  set_root_env_path "$svc"
  install -m 0600 -o root -g root "$ROOT_ENV_PATH" "$dir/.env"
}

# A credential for a private fetch arrives on stdin, is validated, and is
# passed to git through the environment. The environment of a root process is
# not readable by the runner; an argv is.
read_fetch_credential() {
  local tok=''
  read -r -t 10 tok </dev/stdin || true
  [[ -n "$tok" ]] || die 'this service needs a fetch credential on stdin'
  [[ "$tok" =~ ^[A-Za-z0-9_.-]{20,512}$ ]] || die 'malformed fetch credential'
  GIT_CONFIG_COUNT=1
  GIT_CONFIG_KEY_0='http.extraHeader'
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$tok" | base64 -w0)"
  export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
}

# Fetch main, then refuse anything not already an ancestor of origin/main.
# A SHA that only exists on a branch, or was force-pushed away, must not deploy.
cmd_sync() {
  local svc="$1" sha="$2" dir
  dir="$(checkout_dir "$svc")"
  [[ -z "${AUTH[$svc]+set}" ]] || read_fetch_credential
  if [[ ! -d "$dir/.git" ]]; then
    install -d -m 0755 -o root -g root "$STATE_ROOT"
    "$GIT" clone --quiet "${REPOS[$svc]}" "$dir"
  fi
  "$GIT" -C "$dir" fetch --quiet origin main
  "$GIT" -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null || die 'sha not found after fetch'
  "$GIT" -C "$dir" merge-base --is-ancestor "$sha" origin/main ||
    die 'refusing: sha is not reachable from origin/main'
  "$GIT" -C "$dir" checkout --quiet --detach "$sha"
  # node_modules is survivable build state, not repo content: wiping it turns
  # every deploy into a cold install. Everything else untracked goes.
  "$GIT" -C "$dir" clean -qxdff -e node_modules
  install_env "$svc"
  printf 'BROKER_SYNC_PASS service=%s sha=%s\n' "$svc" "$(head_sha "$svc")"
}

cmd_pull()  { require_checkout "$1"; compose_env "$1"; set_compose_argv "$1"; "$DOCKER" "${COMPOSE_ARGV[@]}" pull; }
cmd_build() { require_checkout "$1"; compose_env "$1"; set_compose_argv "$1"; "$DOCKER" "${COMPOSE_ARGV[@]}" build; }
cmd_up()    { require_checkout "$1"; compose_env "$1"; set_compose_argv "$1"; "$DOCKER" "${COMPOSE_ARGV[@]}" up -d; }
cmd_ps()    { require_checkout "$1"; compose_env "$1"; set_compose_argv "$1"; "$DOCKER" "${COMPOSE_ARGV[@]}" ps; }
cmd_logs() {
  local n="${2:-100}"
  [[ "$n" =~ ^[0-9]{1,4}$ ]] || die 'log tail must be numeric'
  require_checkout "$1"; compose_env "$1"; set_compose_argv "$1"
  "$DOCKER" "${COMPOSE_ARGV[@]}" logs --tail="$n"
}

# Migrations run as root, because the runner must not hold the credentials that
# can rewrite the schema and must not be able to substitute the migration files.
cmd_migrate() {
  local svc="$1" dir
  [[ -n "${MIGRATE[$svc]+set}" ]] || die "service has no migration recipe: $svc"
  [[ -n "${ENVFILE[$svc]+set}" ]] || die 'migration requires a root-owned env file'
  require_checkout "$svc"
  dir="$(checkout_dir "$svc")"
  case "${MIGRATE[$svc]}" in
    pnpm-prisma)
      ( cd "$dir"
        "$PNPM" install --frozen-lockfile
        set -o allexport
        # shellcheck disable=SC1090
        . "$(env_path "$svc")"
        set +o allexport
        "$PNPM" exec prisma migrate deploy )
      ;;
    compose-run-prisma)
      compose_env "$svc"; set_compose_argv "$svc"
      "$DOCKER" "${COMPOSE_ARGV[@]}" run --rm -T --no-deps \
        --entrypoint sh api -c 'npx prisma migrate deploy'
      ;;
    *) die 'unknown migration recipe' ;;
  esac
  printf 'BROKER_MIGRATE_PASS service=%s\n' "$svc"
}

# Preserve the currently live image before a build overwrites :latest, so a
# rollback has something to roll back to.
cmd_tag_rotate() {
  local svc="$1" img
  [[ -n "${IMAGE[$svc]+set}" ]] || die "service has no local image: $svc"
  img="${IMAGE[$svc]}"
  if "$DOCKER" image inspect "${img}:latest" >/dev/null 2>&1; then
    "$DOCKER" tag "${img}:latest" "${img}:previous"
    printf 'BROKER_TAG_ROTATE_PASS service=%s %s:latest -> %s:previous\n' "$svc" "$img" "$img"
  else
    printf 'BROKER_TAG_ROTATE_SKIP service=%s no prior %s:latest\n' "$svc" "$img"
  fi
}

cmd_tag_release() {
  local svc="$1" img sha
  [[ -n "${IMAGE[$svc]+set}" ]] || die "service has no local image: $svc"
  require_checkout "$svc"
  img="${IMAGE[$svc]}"; sha="$(head_sha "$svc")"
  "$DOCKER" tag "${img}:latest" "${img}:${sha}"
  printf 'BROKER_TAG_RELEASE_PASS service=%s %s:%s\n' "$svc" "$img" "$sha"
}

cmd_image_id() {
  local svc="$1" img sha
  [[ -n "${IMAGE[$svc]+set}" ]] || die "service has no local image: $svc"
  require_checkout "$svc"
  img="${IMAGE[$svc]}"; sha="$(head_sha "$svc")"
  "$DOCKER" image inspect "${img}:${sha}" --format '{{.Id}}'
}

# The digest the verifier compares against is resolved here, from the tag the
# broker itself applied. A caller that could name it could pass verification
# while running a different image.
cmd_verify() {
  local svc="$1" dir script expected
  [[ -n "${VERIFY[$svc]+set}" ]] || die "service has no verify script: $svc"
  require_checkout "$svc"
  dir="$(checkout_dir "$svc")"
  script="$dir/${VERIFY[$svc]}"
  [[ -f "$script" && ! -L "$script" ]] || die 'verify script missing or not a regular file'
  expected="$(cmd_image_id "$svc")"
  compose_env "$svc"
  # INFRA-0378: the verify script defaults its failure dump to a FIXED
  # name under /tmp, so each run destroyed the previous run's evidence and
  # a reboot destroyed all of it. The 2026-08-12 transcribator rollback --
  # which left production on stale code for a week -- was already
  # undiagnosable when found. Give every invocation its own root-owned
  # file that outlives the incident.
  mkdir -p /var/log/arcanada-deploy && chmod 750 /var/log/arcanada-deploy
  local failure_log
  failure_log="/var/log/arcanada-deploy/verify-${svc}-$(date -u +%Y%m%dT%H%M%SZ).log"
  # INFRA-0379: hand the verify script the Ops Bot key so its FATAL branch
  # can actually raise the alarm. sudo strips the CI environment (the
  # sudoers grant carries no SETENV, deliberately) and compose_env exports
  # only BUILD_SHA, so before this the notifier printed "OPSBOT_API_KEY not
  # set — skipping" and the deploy reported success while production ran
  # rolled-back code. Read from the ROOT-OWNED env file, which the runner
  # account cannot read; never exported to compose or written to the
  # checkout.
  local opsbot_key=''
  if [[ -n "${ENVFILE[$svc]+set}" && -r "${ENVFILE[$svc]}" ]]; then
    opsbot_key="$(sed -n 's/^OPSBOT_API_KEY=//p' "${ENVFILE[$svc]}" | head -n1)"
  fi
  ( cd "$dir"
    EXPECTED_IMAGE_SHA="$expected" \
    GITHUB_SHA="$(head_sha "$svc")" \
    COMPOSE_FILE="${COMPOSE[$svc]}" \
    VERIFY_FAILURE_LOG="$failure_log" \
    OPSBOT_API_KEY="$opsbot_key" \
    bash "$script" )
}

# Rollback ends with its own verification, and a rollback that is not verified
# is a rollback that might have restored nothing. The bgutil provider is
# excluded because it is not recreated here, and no expected digest is passed
# because the image being restored is deliberately the previous one.
cmd_rollback() {
  local svc="$1" img dir script
  local -a services
  [[ -n "${IMAGE[$svc]+set}" && -n "${ROLLBACK_SERVICES[$svc]+set}" ]] ||
    die "service has no rollback recipe: $svc"
  require_checkout "$svc"
  img="${IMAGE[$svc]}"
  "$DOCKER" image inspect "${img}:previous" >/dev/null 2>&1 ||
    die 'no :previous image — first deploy or pruned; cannot roll back'
  "$DOCKER" tag "${img}:previous" "${img}:latest"
  compose_env "$svc"; set_compose_argv "$svc"
  IFS=' ' read -r -a services <<< "${ROLLBACK_SERVICES[$svc]}"
  "$DOCKER" "${COMPOSE_ARGV[@]}" up -d --force-recreate "${services[@]}"
  if [[ -n "${VERIFY[$svc]+set}" ]]; then
    sleep 30
    dir="$(checkout_dir "$svc")"
    script="$dir/${VERIFY[$svc]}"
    [[ -f "$script" && ! -L "$script" ]] || die 'verify script missing or not a regular file'
    ( cd "$dir"
      VERIFY_REQUIRE_BGUTIL_PROVIDER=0 \
      COMPOSE_FILE="${COMPOSE[$svc]}" \
      bash "$script" )
  fi
  printf 'BROKER_ROLLBACK_PASS service=%s\n' "$svc"
}

cmd_promote() {
  local svc="$1" img
  [[ -n "${IMAGE[$svc]+set}" ]] || die "service has no local image: $svc"
  img="${IMAGE[$svc]}"
  "$DOCKER" tag "${img}:latest" "${img}:stable"
  printf 'BROKER_PROMOTE_PASS service=%s %s:stable\n' "$svc" "$img"
}

cmd_prune() { "$DOCKER" image prune --filter 'until=336h' -f; }

# INFRA-0417 — an EPHEMERAL registry credential for services whose release
# image lives in a private GHCR package.
#
# Why this is needed at all: `cmd_pull` runs as root, and root's docker config
# on both arcana-prod and arcana-prd holds no registry auth (verified: `auths`
# is empty on each). A service whose image is public pulls fine; a private one
# fails with `unauthorized`. Until now the only service in this table pulling a
# private image got away with it because the image already happened to be on
# the host from an earlier build — a coincidence, not a mechanism, and one that
# does not survive a move to another machine.
#
# Why not a stored credential: a long-lived token in /root/.docker is exactly
# how auth-arcana's registry access was lost once already (INFRA-0434) — it
# expired, nothing re-established it, and production deploys became silently
# impossible for a month. So the workflow calls `registry-login` immediately
# before the pull with its per-run GITHUB_TOKEN and `registry-logout` after.
# Nothing durable is stored, so there is nothing left to expire.
#
# Narrow on purpose, following the reviewed auth-arcana-ghcr-login helper: the
# registry is compiled in, the token is read from stdin ONLY (never argv, where
# /proc/<pid>/cmdline would expose it), the username is pattern-checked so it
# cannot smuggle flags into `docker login`, and nothing is echoed.
#
# The login it establishes is a property of the HOST's docker config, not of
# the named service, so the service argument would otherwise be decoration. It
# is not: only services declared here may reach these two verbs, so adding a
# service to the deploy allowlist does not silently also grant it the ability
# to place a registry credential on the host.
readonly REGISTRY='ghcr.io'
declare -rA REGISTRY_AUTH=(
  [verdicus]='yes'
)

cmd_registry_login() {
  local svc="$1" user="$2" token=''
  [[ -n "${REGISTRY_AUTH[$svc]+set}" ]] ||
    die "service may not establish a registry credential: $svc"
  [[ "$user" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$ ]] ||
    die 'implausible registry username'
  read -r -t 10 token </dev/stdin || true
  [[ -n "$token" ]] || die 'registry login needs a credential on stdin'
  [[ "$token" =~ ^[A-Za-z0-9_.-]{20,512}$ ]] || die 'malformed registry credential'
  printf '%s' "$token" |
    "$DOCKER" login "$REGISTRY" -u "$user" --password-stdin >/dev/null
  printf 'registry-login: authenticated to %s\n' "$REGISTRY"
}

cmd_registry_logout() {
  local svc="$1"
  [[ -n "${REGISTRY_AUTH[$svc]+set}" ]] ||
    die "service may not clear a registry credential: $svc"
  "$DOCKER" logout "$REGISTRY" >/dev/null 2>&1 || true
  printf 'registry-logout: cleared %s\n' "$REGISTRY"
}

cmd_run_deploy() {
  local svc="$1" dir script
  [[ -n "${SCRIPT[$svc]+set}" ]] || die "service has no deploy script: $svc"
  require_checkout "$svc"
  dir="$(checkout_dir "$svc")"
  script="$dir/${SCRIPT[$svc]}"
  [[ -f "$script" && ! -L "$script" ]] || die 'deploy script missing or not a regular file'
  compose_env "$svc"
  ( cd "$dir" && bash "$script" )
  printf 'BROKER_RUN_DEPLOY_PASS service=%s\n' "$svc"
}

# Defends against a silent no-op build: a container that was not recreated is
# running the previous code no matter how green the deploy looks.
cmd_freshness() {
  local svc="$1" name max created age
  [[ -n "${CONTAINER[$svc]+set}" && -n "${MAXAGE[$svc]+set}" ]] ||
    die "service has no freshness contract: $svc"
  name="${CONTAINER[$svc]}"; max="${MAXAGE[$svc]}"
  created="$("$DOCKER" inspect "$name" --format '{{.Created}}')"
  age=$(( $(date +%s) - $(date -d "$created" +%s) ))
  [[ "$age" -le "$max" ]] ||
    die "container ${name} is ${age}s old (limit ${max}s) — deploy did not recreate it"
  printf 'BROKER_FRESHNESS_PASS service=%s age=%ss\n' "$svc" "$age"
}

cmd_smoke() {
  local svc="$1" name argv
  [[ -n "${CONTAINER[$svc]+set}" && -n "${SMOKE[$svc]+set}" ]] ||
    die "service has no smoke check: $svc"
  name="${CONTAINER[$svc]}"
  IFS=' ' read -r -a argv <<< "${SMOKE[$svc]}"
  "$DOCKER" exec "$name" "${argv[@]}"
  printf 'BROKER_SMOKE_PASS service=%s\n' "$svc"
}

cmd_env_get() {
  local svc="$1" key="$2" name allowed found=0
  local -a allowlist
  [[ -n "${CONTAINER[$svc]+set}" && -n "${ENVKEYS[$svc]+set}" ]] ||
    die "service exposes no environment keys: $svc"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] || die 'invalid environment key'
  # Explicit IFS: the script-wide IFS excludes the space these lists use.
  IFS=' ' read -r -a allowlist <<< "${ENVKEYS[$svc]}"
  for allowed in "${allowlist[@]}"; do
    [[ "$allowed" == "$key" ]] && found=1
  done
  [[ "$found" -eq 1 ]] || die "environment key not readable: $key"
  name="${CONTAINER[$svc]}"
  "$DOCKER" inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    awk -F= -v k="$key" '$1 == k { print substr($0, length(k) + 2); exit }'
}

cmd_aggregate_readback() {
  local svc="$1" dir script
  [[ -n "${AGGREGATE_READBACK[$svc]+set}" ]] ||
    die "service has no aggregate readback: $svc"
  require_checkout "$svc"
  dir="$(checkout_dir "$svc")"
  script="$dir/${AGGREGATE_READBACK[$svc]}"
  [[ -f "$script" && ! -L "$script" ]] ||
    die 'aggregate readback helper missing or not a regular file'
  set_root_env_path "$svc"
  (
    cd "$dir"
    set -o allexport
    # shellcheck disable=SC1090
    . "$ROOT_ENV_PATH"
    set +o allexport
    "$NODE" "$script"
  )
}

usage='usage: <service> {sync <sha>|pull|build|up|ps|logs [n]|migrate|tag-rotate|tag-release|image-id|verify|rollback|promote|prune|freshness|smoke|env-get <KEY>|aggregate-readback|run-deploy|registry-login <user>|registry-logout}'

main() {
  [[ $# -ge 2 ]] || die "$usage"
  local svc action
  svc="$(validate_service "$1")"; action="$2"; shift 2
  case "$action" in
    sync)         [[ $# -eq 1 ]] || die 'sync takes exactly one sha'; cmd_sync "$svc" "$(validate_sha "$1")" ;;
    pull)         [[ $# -eq 0 ]] || die 'pull takes no arguments'; cmd_pull "$svc" ;;
    build)        [[ $# -eq 0 ]] || die 'build takes no arguments'; cmd_build "$svc" ;;
    up)           [[ $# -eq 0 ]] || die 'up takes no arguments'; cmd_up "$svc" ;;
    ps)           [[ $# -eq 0 ]] || die 'ps takes no arguments'; cmd_ps "$svc" ;;
    logs)         [[ $# -le 1 ]] || die 'logs takes at most one tail count'; cmd_logs "$svc" "${1:-100}" ;;
    migrate)      [[ $# -eq 0 ]] || die 'migrate takes no arguments'; cmd_migrate "$svc" ;;
    tag-rotate)   [[ $# -eq 0 ]] || die 'tag-rotate takes no arguments'; cmd_tag_rotate "$svc" ;;
    tag-release)  [[ $# -eq 0 ]] || die 'tag-release takes no arguments'; cmd_tag_release "$svc" ;;
    image-id)     [[ $# -eq 0 ]] || die 'image-id takes no arguments'; cmd_image_id "$svc" ;;
    verify)       [[ $# -eq 0 ]] || die 'verify takes no arguments'; cmd_verify "$svc" ;;
    rollback)     [[ $# -eq 0 ]] || die 'rollback takes no arguments'; cmd_rollback "$svc" ;;
    promote)      [[ $# -eq 0 ]] || die 'promote takes no arguments'; cmd_promote "$svc" ;;
    prune)        [[ $# -eq 0 ]] || die 'prune takes no arguments'; cmd_prune "$svc" ;;
    freshness)    [[ $# -eq 0 ]] || die 'freshness takes no arguments'; cmd_freshness "$svc" ;;
    smoke)        [[ $# -eq 0 ]] || die 'smoke takes no arguments'; cmd_smoke "$svc" ;;
    env-get)      [[ $# -eq 1 ]] || die 'env-get takes exactly one key'; cmd_env_get "$svc" "$1" ;;
    aggregate-readback)
                  [[ $# -eq 0 ]] || die 'aggregate-readback takes no arguments'
                  cmd_aggregate_readback "$svc"
                  ;;
    run-deploy)   [[ $# -eq 0 ]] || die 'run-deploy takes no arguments'; cmd_run_deploy "$svc" ;;
    registry-login)
                  [[ $# -eq 1 ]] || die 'registry-login takes exactly one username'
                  cmd_registry_login "$svc" "$1"
                  ;;
    registry-logout)
                  [[ $# -eq 0 ]] || die 'registry-logout takes no arguments'
                  cmd_registry_logout "$svc"
                  ;;
    *)            die "unknown action: $action" ;;
  esac
}
main "$@"
