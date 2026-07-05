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
node_modules/.bin/prisma migrate deploy || { echo "[entrypoint] migrate deploy FAILED"; exit 1; }

exec "$@"
