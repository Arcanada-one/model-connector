"""Stage one reviewed installed Compose executable in a private empty HOME.
No account/global plugin changes, fallback executable, daemon operation or flag rewrite.
"""
import hashlib
import os
from pathlib import Path
import stat

SOURCE = Path('/usr/libexec/docker/cli-plugins/docker-compose')
SOURCE_SHA256 = '33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4'
SOURCE_OWNER = 0
MAX_BYTES = 128 * 1024 * 1024


def chain(path, allowed):
    rows = []
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in allowed or info.st_mode & 0o022:
            raise ValueError('Compose custody ancestor refused')
        rows.append((part, info.st_dev, info.st_ino))
    return rows


def unchanged(rows):
    for path, device, inode in rows:
        current = path.lstat()
        if (current.st_dev, current.st_ino) != (device, inode):
            raise ValueError('Compose custody ancestor replaced')


def stage(home):
    home = Path(home)
    if not home.is_absolute():
        raise ValueError('Compose private HOME must be absolute')
    parents = chain(home, {0, os.getuid()})
    owner = home.lstat()
    if owner.st_uid != os.getuid() or stat.S_IMODE(owner.st_mode) != 0o700 or any(home.iterdir()):
        raise ValueError('Compose HOME is not exclusive empty private custody')
    source_parents = chain(SOURCE.parent, {0, SOURCE_OWNER})
    fd = os.open(SOURCE, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != SOURCE_OWNER or before.st_mode & 0o022 or not before.st_mode & 0o111 or before.st_size > MAX_BYTES or before.st_nlink != 1:
            raise ValueError('Compose installed executable custody refused')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            content = stream.read(MAX_BYTES + 1)
        after = os.fstat(fd)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or len(content) != before.st_size:
            raise ValueError('Compose installed executable changed')
        if hashlib.sha256(content).hexdigest() != SOURCE_SHA256:
            raise ValueError('Compose installed executable hash mismatch')
    finally:
        os.close(fd)
    unchanged(source_parents); unchanged(parents)
    # All creations are exclusive; partial owned custody remains on any failure.
    docker = home / '.docker'; docker.mkdir(mode=0o700)
    plugins = docker / 'cli-plugins'; plugins.mkdir(mode=0o700)
    destination = plugins / 'docker-compose'
    output = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
    created = os.fstat(output)
    try:
        with os.fdopen(output, 'wb', closefd=False) as stream:
            stream.write(content); stream.flush(); os.fsync(output)
        os.fchmod(output, 0o500)
    finally:
        os.close(output)
    unchanged(parents)
    readback = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        received = os.fstat(readback)
        if (received.st_dev,received.st_ino) != (created.st_dev,created.st_ino) or received.st_nlink != 1 or received.st_uid != os.getuid() or stat.S_IMODE(received.st_mode) != 0o500:
            raise ValueError('Compose private copy custody changed')
        with os.fdopen(readback, 'rb', closefd=False) as stream:
            copied = stream.read(MAX_BYTES + 1)
        if copied != content or hashlib.sha256(copied).hexdigest() != SOURCE_SHA256:
            raise ValueError('Compose private copy hash mismatch')
    finally:
        os.close(readback)
    return {'schema':'ComposePrivateExecutableCustody/v1','sha256':SOURCE_SHA256,
            'source_owner':SOURCE_OWNER,'bytes':len(content),'global_changes':False}
