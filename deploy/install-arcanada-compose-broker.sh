#!/usr/bin/env bash
# SEC-0028 — root install of the compose broker from a clean checkout.
# Deliberately NOT reachable from runner sudo: a runner that can re-install its
# own broker can rewrite the rules it is bound by.
set -euo pipefail
IFS=$'\n\t'
[[ "$(id -u)" -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
# Restore a retained reviewed broker generation without touching sudoers,
# service state, images or daemon. Root custody/review still applies.
if [[ $# -eq 2 && "$1" == --restore ]]; then
  [[ "$2" =~ ^[0-9a-f]{64}$ ]] || exit 1
  backup="/usr/local/lib/arcanada-compose-broker/broker-$2.sh"
  for parent in /usr /usr/local /usr/local/lib /usr/local/sbin /usr/local/lib/arcanada-compose-broker; do
    [[ -d "$parent" && ! -L "$parent" && "$(stat -c '%U' "$parent")" == root ]] || exit 1
    [[ $(( 8#$(stat -c '%a' "$parent") & 8#022 )) -eq 0 ]] || exit 1
  done
  [[ -f "$backup" && ! -L "$backup" && "$(stat -c '%U:%G:%a' "$backup")" == root:root:600 ]] || exit 1
  [[ "$(sha256sum "$backup" | cut -d' ' -f1)" == "$2" ]] || exit 1
  restored="$(mktemp /usr/local/sbin/.compose-broker-restore.XXXXXXXX)"
  install -m 0755 -o root -g root "$backup" "$restored"
  mv -T "$restored" /usr/local/sbin/arcanada-compose-broker
  echo "COMPOSE_BROKER_RESTORE_PASS sha256=$2"
  exit 0
fi
[[ $# -eq 1 ]] || { echo 'usage: install-arcanada-compose-broker.sh <broker_sha256>' >&2; exit 1; }
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/arcanada-compose-broker.sh"
sudoers_src="$(dirname "$src")/arcanada-compose-broker.sudoers"
actual="$(sha256sum "$src" | cut -d' ' -f1)"
[[ "$actual" == "$1" ]] || { echo "broker sha256 mismatch: $actual" >&2; exit 1; }
# Install the pinned helper first: publishing the new broker last is the
# activation boundary. Old helper generations remain available for rollback.
transaction_src="$(dirname "$src")/billing-transaction.py"
transaction_sha="$(sha256sum "$transaction_src" | cut -d' ' -f1)"
expected_transaction="$(sed -n 's/^readonly BILLING_TRANSACTION_SHA=//p' "$src")"
[[ "$transaction_sha" == "$expected_transaction" ]] || { echo 'transaction source mismatch' >&2; exit 1; }
helper_root=/usr/local/lib/arcanada-compose-broker
for parent in /usr /usr/local /usr/local/lib /usr/local/sbin /etc /etc/sudoers.d; do
  [[ -d "$parent" && ! -L "$parent" && "$(stat -c '%U' "$parent")" == root ]] || exit 1
  [[ $(( 8#$(stat -c '%a' "$parent") & 8#022 )) -eq 0 ]] || exit 1
done
[[ ! -L "$helper_root" ]] || exit 1
if [[ -e "$helper_root" ]]; then
  [[ -d "$helper_root" && "$(stat -c '%U:%G:%a' "$helper_root")" == root:root:700 ]] || exit 1
else
  install -d -m 0700 -o root -g root "$helper_root"
fi
helper="$helper_root/$transaction_sha.py"
if [[ -e "$helper" ]]; then
  [[ -f "$helper" && ! -L "$helper" && "$(stat -c '%U:%G:%a' "$helper")" == root:root:600 ]] || exit 1
  [[ "$(sha256sum "$helper" | cut -d' ' -f1)" == "$transaction_sha" ]] || exit 1
else
  pending="$(mktemp "$helper_root/.pending.XXXXXXXX")"
  install -m 0600 -o root -g root "$transaction_src" "$pending"
  mv -T "$pending" "$helper"
fi
# Retain the exact prior reviewed code before the final publication boundary.
old_broker=/usr/local/sbin/arcanada-compose-broker
if [[ -e "$old_broker" || -L "$old_broker" ]]; then
  [[ -f "$old_broker" && ! -L "$old_broker" && "$(stat -c '%U:%G:%a' "$old_broker")" == root:root:755 ]] || exit 1
  old_sha="$(sha256sum "$old_broker" | cut -d' ' -f1)"
  old_backup="$helper_root/broker-$old_sha.sh"
  if [[ -e "$old_backup" || -L "$old_backup" ]]; then
    [[ -f "$old_backup" && ! -L "$old_backup" && "$(stat -c '%U:%G:%a' "$old_backup")" == root:root:600 ]] || exit 1
    [[ "$(sha256sum "$old_backup" | cut -d' ' -f1)" == "$old_sha" ]] || exit 1
  else
    old_pending="$(mktemp "$helper_root/.broker-baseline.XXXXXXXX")"
    install -m 0600 -o root -g root "$old_broker" "$old_pending"
    mv -T "$old_pending" "$old_backup"
  fi
fi
# Validate sudoers before replacing anything; no privilege expansion.
expected_sudoers="$(sed -n 's/^readonly BILLING_SUDOERS_SHA=//p' "$src")"
[[ "$(sha256sum "$sudoers_src" | cut -d' ' -f1)" == "$expected_sudoers" ]] || { echo 'sudoers source mismatch' >&2; exit 1; }
visudo -cf "$sudoers_src"
broker_pending="$(mktemp /usr/local/sbin/.compose-broker.XXXXXXXX)"
install -m 0755 -o root -g root "$src" "$broker_pending"
install -m 0440 -o root -g root "$sudoers_src" /etc/sudoers.d/arcanada-compose-broker
visudo -cf /etc/sudoers.d/arcanada-compose-broker
install -d -m 0755 -o root -g root /var/lib/arcanada-deploy
# Root-owned environment files for services whose container env must not be
# runner-writable. The directory is created here; the files themselves stay
# operator-managed and are never carried in the repo.
install -d -m 0700 -o root -g root /etc/arcanada/deploy-env
mv -T "$broker_pending" /usr/local/sbin/arcanada-compose-broker
echo "COMPOSE_BROKER_INSTALL_PASS sha256=$actual"
