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
# in ENVFILE take their environment from a root-owned file under
# /etc/arcanada/deploy-env, re-installed into the checkout on every sync. The
# runner can neither read nor write it.
set -euo pipefail
IFS=$'\n\t'
umask 022
readonly STATE_ROOT=/var/lib/arcanada-deploy
readonly ENV_ROOT=/etc/arcanada/deploy-env
readonly GIT=/usr/bin/git
readonly DOCKER=/usr/bin/docker
readonly PNPM=/usr/bin/pnpm
# service -> repo url   (edit here, re-install, never parameterise)
declare -rA REPOS=(
  [model-connector]='https://github.com/Arcanada-one/model-connector.git'
  [muneral]='https://github.com/Arcanada-one/muneral.git'
)
declare -rA COMPOSE=(
  [model-connector]='deploy/stt-whisper/docker-compose.yml'
  [muneral]='docker-compose.prod.yml'
)
# Optional: pin the compose project name. Unset means Compose derives it from
# the checkout directory, which is what the whisper stack has always done —
# setting it here retroactively would rename its project and orphan its
# containers.
declare -rA PROJECT=(
  [muneral]='muneral'
)
# Optional: basename under ENV_ROOT of the root-owned environment file.
declare -rA ENVFILE=(
  [muneral]='muneral.env'
)
# Optional: schema-migration recipe run before `up`.
declare -rA MIGRATE=(
  [muneral]='pnpm-prisma'
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
install_env() {
  local svc="$1" dir src
  [[ -n "${ENVFILE[$svc]+set}" ]] || return 0
  dir="$(checkout_dir "$svc")"
  src="$ENV_ROOT/${ENVFILE[$svc]}"
  [[ -f "$src" && ! -L "$src" ]] || die "root-owned env file missing: $src"
  install -m 0600 -o root -g root "$src" "$dir/.env"
}
# Fetch main, then refuse anything not already an ancestor of origin/main.
# A SHA that only exists on a branch, or was force-pushed away, must not deploy.
cmd_sync() {
  local svc="$1" sha="$2" dir
  dir="$(checkout_dir "$svc")"
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
  printf 'BROKER_SYNC_PASS service=%s sha=%s\n' "$svc" "$("$GIT" -C "$dir" rev-parse HEAD)"
}
cmd_pull()  { set_compose_argv "$1"; "$DOCKER" "${COMPOSE_ARGV[@]}" pull; }
cmd_build() { set_compose_argv "$1"; "$DOCKER" "${COMPOSE_ARGV[@]}" build; }
cmd_up()    { set_compose_argv "$1"; "$DOCKER" "${COMPOSE_ARGV[@]}" up -d; }
cmd_ps()    { set_compose_argv "$1"; "$DOCKER" "${COMPOSE_ARGV[@]}" ps; }
cmd_logs() {
  local n="${2:-100}"
  [[ "$n" =~ ^[0-9]{1,4}$ ]] || die 'log tail must be numeric'
  set_compose_argv "$1"
  "$DOCKER" "${COMPOSE_ARGV[@]}" logs --tail="$n"
}
# Migrations run as root from the root-owned checkout with the root-owned env,
# because the runner must not hold the credentials that can rewrite the schema
# and must not be able to substitute the migration files.
cmd_migrate() {
  local svc="$1" dir
  [[ -n "${MIGRATE[$svc]+set}" ]] || die "service has no migration recipe: $svc"
  [[ "${MIGRATE[$svc]}" == 'pnpm-prisma' ]] || die 'unknown migration recipe'
  [[ -n "${ENVFILE[$svc]+set}" ]] || die 'migration requires a root-owned env file'
  dir="$(checkout_dir "$svc")"
  [[ -d "$dir/.git" ]] || die 'checkout missing — sync first'
  ( cd "$dir"
    "$PNPM" install --frozen-lockfile
    set -o allexport
    # shellcheck disable=SC1090
    . "$ENV_ROOT/${ENVFILE[$svc]}"
    set +o allexport
    "$PNPM" exec prisma migrate deploy )
  printf 'BROKER_MIGRATE_PASS service=%s\n' "$svc"
}
main() {
  [[ $# -ge 2 ]] || die 'usage: <service> {sync <sha>|pull|build|up|ps|logs [n]|migrate}'
  local svc action
  svc="$(validate_service "$1")"; action="$2"; shift 2
  case "$action" in
    sync)    [[ $# -eq 1 ]] || die 'sync takes exactly one sha'; cmd_sync "$svc" "$(validate_sha "$1")" ;;
    pull)    [[ $# -eq 0 ]] || die 'pull takes no arguments'; cmd_pull "$svc" ;;
    build)   [[ $# -eq 0 ]] || die 'build takes no arguments'; cmd_build "$svc" ;;
    up)      [[ $# -eq 0 ]] || die 'up takes no arguments'; cmd_up "$svc" ;;
    ps)      [[ $# -eq 0 ]] || die 'ps takes no arguments'; cmd_ps "$svc" ;;
    logs)    [[ $# -le 1 ]] || die 'logs takes at most one tail count'; cmd_logs "$svc" "${1:-100}" ;;
    migrate) [[ $# -eq 0 ]] || die 'migrate takes no arguments'; cmd_migrate "$svc" ;;
    *)       die "unknown action: $action" ;;
  esac
}
main "$@"
