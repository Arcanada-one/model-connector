#!/usr/bin/env bash
# SEC-0028 — root install of the compose broker from a clean checkout.
# Deliberately NOT reachable from runner sudo: a runner that can re-install its
# own broker can rewrite the rules it is bound by.
set -euo pipefail
IFS=$'\n\t'
[[ "$(id -u)" -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
[[ $# -eq 1 ]] || { echo 'usage: install-arcanada-compose-broker.sh <broker_sha256>' >&2; exit 1; }
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/arcanada-compose-broker.sh"
sudoers_src="$(dirname "$src")/arcanada-compose-broker.sudoers"
actual="$(sha256sum "$src" | cut -d' ' -f1)"
[[ "$actual" == "$1" ]] || { echo "broker sha256 mismatch: $actual" >&2; exit 1; }
install -m 0755 -o root -g root "$src" /usr/local/sbin/arcanada-compose-broker
install -m 0440 -o root -g root "$sudoers_src" /etc/sudoers.d/arcanada-compose-broker
visudo -cf /etc/sudoers.d/arcanada-compose-broker
install -d -m 0755 -o root -g root /var/lib/arcanada-deploy
echo "COMPOSE_BROKER_INSTALL_PASS sha256=$actual"
