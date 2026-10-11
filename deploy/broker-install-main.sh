#!/usr/bin/env bash
# Fixed source-owned mode of the existing model-connector run-deploy route.
# No active request is shipped: adoption is a separate reviewed main change.
set -euo pipefail
readonly ROOT=/var/lib/arcanada-deploy/model-connector
[[ $# -eq 0 && "$(id -u)" -eq 0 ]] || { echo 'BROKER_MAIN_INSTALL_REFUSED_ACTOR' >&2; exit 1; }
for parent in /var /var/lib /var/lib/arcanada-deploy "$ROOT" "$ROOT/deploy"; do
  [[ -d "$parent" && ! -L "$parent" && "$(stat -c '%U' "$parent")" == root ]] || exit 1
  [[ $(( 8#$(stat -c '%a' "$parent") & 8#022 )) -eq 0 ]] || exit 1
done
readonly REQUEST="$ROOT/deploy/broker-install-only.request"
[[ -f "$REQUEST" && ! -L "$REQUEST" && "$(stat -c '%U' "$REQUEST")" == root ]] || exit 1
[[ $(( 8#$(stat -c '%a' "$REQUEST") & 8#022 )) -eq 0 ]] || exit 1
# This is reviewed repository content, not runner stdin/environment/argv.
[[ "$(wc -l < "$REQUEST")" -eq 1 ]] || exit 1
IFS=: read -r action expected extra < "$REQUEST"
[[ -z "${extra:-}" && "$expected" =~ ^[0-9a-f]{64}$ ]] || exit 1
case "$action" in install|restore) ;; *) exit 1 ;; esac
/usr/bin/git -C "$ROOT" ls-files --error-unmatch -- deploy/broker-install-only.request deploy/broker-install-main.sh deploy/deploy.sh deploy/install-arcanada-compose-broker.sh deploy/arcanada-compose-broker.sh >/dev/null
head="$(/usr/bin/git -C "$ROOT" rev-parse HEAD)"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || exit 1
/usr/bin/git -C "$ROOT" merge-base --is-ancestor "$head" origin/main || exit 1
[[ -z "$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || exit 1
/usr/bin/git -C "$ROOT" ls-files -v | /usr/bin/awk '/^[a-zS]/ { bad=1 } END { exit bad }'
# All invoked code is fixed, clean, root-owned main checkout content.
readonly INSTALLER="$ROOT/deploy/install-arcanada-compose-broker.sh"
for source in "$INSTALLER" "$ROOT/deploy/arcanada-compose-broker.sh"; do
  [[ -f "$source" && ! -L "$source" && "$(stat -c '%U' "$source")" == root ]] || exit 1
  [[ $(( 8#$(stat -c '%a' "$source") & 8#022 )) -eq 0 ]] || exit 1
done
case "$action" in
  install) /usr/bin/bash "$INSTALLER" "$expected" ;;
  restore) /usr/bin/bash "$INSTALLER" --restore "$expected" ;;
esac
[[ "$(/usr/bin/sha256sum /usr/local/sbin/arcanada-compose-broker | /usr/bin/cut -d' ' -f1)" == "$expected" ]] || exit 1
printf 'BROKER_STOCK_MAIN_%s_PASS source=%s broker=%s\n' "$action" "$head" "$expected"
