#!/usr/bin/env bash
# Unit tests for is_tmpfs_mount (CONN-0079).
# Fixture lines captured from PROD sidecar probe — see datarim/tasks/CONN-0079-fixtures.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/is_tmpfs_mount.sh
source "${SCRIPT_DIR}/lib/is_tmpfs_mount.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

fail=0
assert_exit() {
    local label="$1" want="$2" got="$3"
    if [ "${want}" = "${got}" ]; then
        printf 'ok   %s (exit=%s)\n' "${label}" "${got}"
    else
        printf 'FAIL %s: want exit=%s got exit=%s\n' "${label}" "${want}" "${got}"
        fail=1
    fi
}

# F-1 — tmpfs bind (PROD-shape line). Expected: exit 0.
printf '1517 1512 0:26 /codex-auth /dev/shm/codex-auth rw,nosuid,nodev - tmpfs tmpfs rw,inode64\n' \
    > "${TMPDIR}/f1.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f1.mountinfo"; rc=$?; set -e
assert_exit "F-1 tmpfs bind"            0 "${rc}"

# F-2 — ext4 bind at same target. Expected: exit 1 (fail-closed).
printf '3402 3401 8:1 /payload /dev/shm/codex-auth rw,relatime - ext4 /dev/sda1 rw,errors=remount-ro\n' \
    > "${TMPDIR}/f2.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f2.mountinfo"; rc=$?; set -e
assert_exit "F-2 ext4 bind"             1 "${rc}"

# F-3 — target absent from mountinfo. Expected: exit 1.
printf '%s\n' \
    '22 21 0:5 / /dev rw,nosuid - devtmpfs devtmpfs rw,size=4G' \
    '1517 1512 0:26 / /dev/shm rw,nosuid,nodev - tmpfs tmpfs rw,inode64' \
    > "${TMPDIR}/f3.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f3.mountinfo"; rc=$?; set -e
assert_exit "F-3 target absent"         1 "${rc}"

# F-4 — overlay at target (defense-in-depth: not tmpfs source). Expected: exit 1.
printf '4001 4000 0:30 /sub /dev/shm/codex-auth rw,relatime - overlay overlay rw,lowerdir=/a:/b\n' \
    > "${TMPDIR}/f4.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f4.mountinfo"; rc=$?; set -e
assert_exit "F-4 overlay at target"     1 "${rc}"

# F-5 — empty mountinfo. Expected: exit 1.
: > "${TMPDIR}/f5.mountinfo"
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/f5.mountinfo"; rc=$?; set -e
assert_exit "F-5 empty mountinfo"       1 "${rc}"

# F-6 — mountinfo unreadable / missing path. Expected: exit 1.
set +e; is_tmpfs_mount /dev/shm/codex-auth "${TMPDIR}/does-not-exist"; rc=$?; set -e
assert_exit "F-6 missing mountinfo"     1 "${rc}"

if [ "${fail}" -eq 0 ]; then
    printf '\nall tests passed\n'
fi
exit "${fail}"
