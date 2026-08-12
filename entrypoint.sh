#!/bin/bash
# Start D-Bus session + gnome-keyring for Cursor CLI auth persistence.
# Cursor stores tokens in OS keyring via libsecret → gnome-keyring.
# Without a running D-Bus + unlocked keyring, auth is lost on container restart.
#
# CONN-0015: use --login (not --unlock) so gnome-keyring creates a persistent
# login.keyring file in ~/.local/share/keyrings/ (Docker named volume).
# This allows auth tokens to survive `docker compose up --build`.

# Start D-Bus session daemon
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS

# Initialize gnome-keyring with empty password — --login creates/loads
# persistent keyring file on disk (unlike --unlock which is memory-only)
echo -n "" | gnome-keyring-daemon --login --components=secrets
echo -n "" | gnome-keyring-daemon --start --components=secrets
export GNOME_KEYRING_CONTROL

# CONN-0245: DB is source of truth for the catalog — apply pending migrations on boot.
# prisma CLI is present (node_modules copied from build stage installed with --prod=false).
echo "[entrypoint] running prisma migrate deploy..."
if ! node_modules/.bin/prisma migrate deploy 2>/tmp/mc-migrate.err; then
  cat /tmp/mc-migrate.err
  # P3005: the DB is non-empty but has no prisma migration history — it was
  # provisioned by `prisma db push` (e.g. the CI docker-e2e ephemeral Postgres),
  # so the schema is ALREADY at the current state and there is nothing to apply.
  # Continue booting in that case; fail closed on any other migrate error so a
  # genuine migration problem never silently ships.
  if grep -qiE "P3005|schema is not empty" /tmp/mc-migrate.err; then
    echo "[entrypoint] DB has no migration history but schema is present (db push-managed) — skipping migrate deploy, continuing boot"
  else
    echo "[entrypoint] migrate deploy FAILED"; exit 1
  fi
fi

# CONN-1666: source per-agent provider keys from Vault into process env only
# (never written to disk). No-op when MC_VAULT_ROLE_ID is unset (.env keys
# stay in effect); FATAL on partial config or an unreadable secret, because a
# silently missing per-agent key would route that agent's traffic through the
# shared key — exactly what the CONN-1665 policy layer forbids.
echo "[entrypoint] sourcing provider keys from Vault (if configured)..."
if ! VAULT_EXPORTS="$(node scripts/vault-provider-keys.mjs)"; then
  echo "[entrypoint] Vault provider-key sourcing FAILED"
  exit 78
fi
eval "$VAULT_EXPORTS"
unset VAULT_EXPORTS

exec "$@"
