#!/usr/bin/env bash
# is_tmpfs_mount — kernel-authoritative tmpfs check via /proc/self/mountinfo.
#
# Sourced by scripts/codex-sidecar-entrypoint.sh and scripts/codex-sidecar-entrypoint.test.sh.
#
# Why this exists (CONN-0079): the prior implementation called busybox `mountpoint -q`
# first, which exits 1 under sidecar caps (`cap_drop=ALL`, `read_only=true`,
# `security_opt=no-new-privileges`) because `..` traversal returns EACCES.
# /proc/self/mountinfo is readable to the calling process and reflects kernel state
# directly; field $5 is the mount-point and field $9 is the mount source (tmpfs by
# convention for tmpfs filesystems). T1 fail-closed semantics preserved: ext4 / overlay
# / absent target all return non-zero.
is_tmpfs_mount() {
    local target="$1"
    local mountinfo="${2:-/proc/self/mountinfo}"
    [ -r "${mountinfo}" ] || return 1
    awk -v t="${target}" '$5 == t && $9 == "tmpfs" { found = 1 } END { exit !found }' \
        "${mountinfo}"
}
