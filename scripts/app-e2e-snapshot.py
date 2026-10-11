"""Export pinned Git bytes and separately copy byte-bound owned dependencies."""
import hashlib, json, os, shutil, subprocess, sys, tarfile
from pathlib import Path


def inventory(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('dependency root indirection or absence')
    rows = []
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            if not path.resolve(strict=True).is_relative_to(root.resolve()):
                raise ValueError('dependency symlink escapes custody')
            rows.append([name, 'link', os.readlink(path)])
        elif path.is_file():
            rows.append([name, 'file', hashlib.sha256(path.read_bytes()).hexdigest()])
        elif not path.is_dir():
            raise ValueError('unsupported dependency object')
    return rows


def export(root, head, owned):
    def git(*args):
        return subprocess.check_output(['git', '-c', f'safe.directory={root}', '-C', str(root), *args])
    if git('rev-parse', head).decode().strip() != head:
        raise ValueError('nonexact source head')
    source = owned / 'source'; source.mkdir(mode=0o700)
    archive = owned / 'source.tar'; archive.write_bytes(git('archive', head))
    with tarfile.open(archive) as stream:
        if any(m.issym() or m.islnk() or m.name.startswith('/') or '..' in Path(m.name).parts for m in stream.getmembers()):
            raise ValueError('source archive indirection')
        stream.extractall(source, filter='data')
    # The export is private but readable by the same UID as the qualified dependencies.
    custody_stat = (root / 'node_modules').stat()
    before = inventory(root / 'node_modules')
    deps = owned / 'dependencies'; deps.mkdir(mode=0o700)
    shutil.copytree(root / 'node_modules', deps / 'node_modules', symlinks=True)
    if os.geteuid() == 0:
        for base in (source, deps):
            for item in [base, *base.rglob('*')]:
                os.chown(item, custody_stat.st_uid, custody_stat.st_gid, follow_symlinks=False)
    after = inventory(deps / 'node_modules')
    if before != after or before != inventory(root / 'node_modules'):
        raise ValueError('dependency bytes changed during custody transfer')
    record = {'schema': 'MCAppE2ECustody/v1', 'head': head,
              'source_archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'lock_sha256': hashlib.sha256((source / 'pnpm-lock.yaml').read_bytes()).hexdigest(),
              'dependency_inventory': after}
    (owned / 'custody.json').write_text(json.dumps(record, sort_keys=True))
    print('APP_E2E_CUSTODY_SHA256=' + hashlib.sha256((owned / 'custody.json').read_bytes()).hexdigest())

if __name__ == '__main__':
    export(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
