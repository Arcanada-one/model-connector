#!/bin/bash
# Start D-Bus session + gnome-keyring for Cursor CLI auth persistence.
# Cursor stores tokens in OS keyring via libsecret → gnome-keyring.
# Without a running D-Bus + unlocked keyring, auth is lost on container restart.

# Start D-Bus session daemon
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS

# Initialize gnome-keyring with empty password (headless unlock)
echo -n "" | gnome-keyring-daemon --unlock --components=secrets
export GNOME_KEYRING_CONTROL

exec "$@"
