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
set -euo pipefail
IFS=$'\n\t'
umask 022

readonly STATE_ROOT=/var/lib/arcanada-deploy
readonly GIT=/usr/bin/git
readonly DOCKER=/usr/bin/docker

# service -> repo_url|compose_relpath   (edit here, re-install, never parameterise)
declare -rA REPOS=(
  [model-connector]='https://github.com/Arcanada-one/model-connector.git'
)
declare -rA COMPOSE=(
  [model-connector]='deploy/stt-whisper/docker-compose.yml'
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

compose_file() {
  local svc="$1" dir file
  dir="$(checkout_dir "$svc")"
  file="$dir/${COMPOSE[$svc]}"
  [[ -f "$file" && ! -L "$file" ]] || die 'compose file missing or not a regular file'
  printf '%s' "$file"
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
  "$GIT" -C "$dir" clean -qxdff
  printf 'BROKER_SYNC_PASS service=%s sha=%s\n' "$svc" "$(git -C "$dir" rev-parse HEAD)"
}

cmd_pull() { "$DOCKER" compose -f "$(compose_file "$1")" pull; }
cmd_up()   { "$DOCKER" compose -f "$(compose_file "$1")" up -d; }
cmd_ps()   { "$DOCKER" compose -f "$(compose_file "$1")" ps; }
cmd_logs() {
  local n="${2:-100}"
  [[ "$n" =~ ^[0-9]{1,4}$ ]] || die 'log tail must be numeric'
  "$DOCKER" compose -f "$(compose_file "$1")" logs --tail="$n"
}

main() {
  [[ $# -ge 2 ]] || die 'usage: <service> {sync <sha>|pull|up|ps|logs [n]}'
  local svc action
  svc="$(validate_service "$1")"; action="$2"; shift 2
  case "$action" in
    sync) [[ $# -eq 1 ]] || die 'sync takes exactly one sha'; cmd_sync "$svc" "$(validate_sha "$1")" ;;
    pull) cmd_pull "$svc" ;;
    up)   cmd_up   "$svc" ;;
    ps)   cmd_ps   "$svc" ;;
    logs) cmd_logs "$svc" "${1:-100}" ;;
    *)    die "unknown action: $action" ;;
  esac
}
main "$@"
