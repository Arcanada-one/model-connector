"""Export pinned Git bytes and separately copy byte-bound owned dependencies."""
import fnmatch, hashlib, json, os, re, shutil, stat, subprocess, sys, tarfile
from pathlib import Path


MAX_BYTES = 2 * 1024 ** 3
MAX_ENTRIES = 200000
MAX_FILE_BYTES = 128 * 1024 ** 2


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(root, workspaces=None):
    workspaces = workspaces or {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('dependency root indirection or absence')
    rows = [['.', 'directory', stat.S_IMODE(root.stat().st_mode)]]
    total = 0
    for path in root.rglob('*'):
        if len(rows) >= MAX_ENTRIES:
            raise ValueError('snapshot entry capacity exceeded')
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(root.resolve()):
                binding = workspaces.get(target)
                lexical = Path(os.path.abspath(path.parent / os.readlink(path)))
                if binding is None or lexical != target or not path.as_posix().endswith('/' + binding['name']):
                    raise ValueError('dependency symlink escapes custody')
                rows.append([name, 'workspace-link', os.readlink(path), binding['path'], binding['tree_oid']])
            else:
                rows.append([name, 'link', os.readlink(path)])
        elif path.is_file():
            size = path.stat().st_size
            total += size
            if size > MAX_FILE_BYTES or total > MAX_BYTES:
                raise ValueError('snapshot byte capacity exceeded')
            rows.append([name, 'file', file_digest(path), stat.S_IMODE(path.stat().st_mode)])
        elif path.is_dir():
            rows.append([name, 'directory', stat.S_IMODE(path.stat().st_mode)])
        else:
            raise ValueError('unsupported dependency object')
    return sorted(rows)


def workspace_bindings(source, head, git):
    manifest = source / 'pnpm-workspace.yaml'
    if not manifest.exists():
        return []
    # Fail closed on unsupported YAML rather than accepting a caller allowlist.
    lines = [line.strip() for line in manifest.read_text().splitlines() if line.strip() and not line.lstrip().startswith('#')]
    if not lines or lines[0] != 'packages:':
        raise ValueError('unsupported workspace declaration')
    patterns = []
    for line in lines[1:]:
        match = re.fullmatch(r'-\s+[\"\']?([A-Za-z0-9_./*-]+)[\"\']?', line)
        if not match or '..' in Path(match[1]).parts or match[1].startswith('/') or '**' in match[1]:
            raise ValueError('unsafe or unsupported workspace declaration')
        patterns.append(match[1])
    bindings = []
    for package in sorted(source.rglob('package.json')):
        relative = package.parent.relative_to(source).as_posix()
        if relative == '.' or not any(len(Path(relative).parts) == len(Path(pattern).parts) and fnmatch.fnmatchcase(relative, pattern) for pattern in patterns):
            continue
        name = json.loads(package.read_text())['name']
        if not isinstance(name, str) or not re.fullmatch(r'(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+', name):
            raise ValueError('invalid workspace package identity')
        oid = git('rev-parse', f'{head}:{relative}').decode().strip()
        if git('cat-file', '-t', oid).strip() != b'tree':
            raise ValueError('workspace target is not an immutable Git tree')
        bindings.append({'path': relative, 'name': name, 'tree_oid': oid,
                         'package_blob_oid': git('rev-parse', f'{head}:{relative}/package.json').decode().strip()})
    if len({row['name'] for row in bindings}) != len(bindings):
        raise ValueError('ambiguous workspace package identity')
    return bindings


def export(root, head, owned):
    def git(*args):
        return subprocess.check_output(['git', '-c', f'safe.directory={root}', '-C', str(root), *args])
    if git('rev-parse', head).decode().strip() != head or git('cat-file', '-t', head).strip() != b'commit':
        raise ValueError('nonexact source head')
    source = owned / 'source'; source.mkdir(mode=0o700)
    archive = owned / 'source.tar'
    process = subprocess.Popen(['git', '-c', f'safe.directory={root}', '-C', str(root), 'archive', head], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        archive_size = 0
        with archive.open('xb') as stream:
            while chunk := process.stdout.read(1024 * 1024):
                archive_size += len(chunk)
                if archive_size > MAX_FILE_BYTES:
                    raise ValueError('Git archive capacity exceeded')
                stream.write(chunk)
        if process.wait(timeout=30):
            raise ValueError('Git archive failed')
    finally:
        if process.poll() is None:
            process.kill(); process.wait()
        process.stdout.close()
    with tarfile.open(archive) as stream:
        if any(m.issym() or m.islnk() or m.name.startswith('/') or '..' in Path(m.name).parts for m in stream.getmembers()):
            raise ValueError('source archive indirection')
        stream.extractall(source, filter='data')
    # Nested Docker binds require an existing destination in a read-only parent.
    # This generated support directory is not represented as a Git source byte.
    mountpoint = source / 'node_modules'
    if os.path.lexists(mountpoint):
        raise ValueError('Git source occupies generated dependency mountpoint')
    mountpoint.mkdir(mode=0o755)
    # The export is private but readable by the same UID as the qualified dependencies.
    custody_stat = (root / 'node_modules').stat()
    bindings = workspace_bindings(source, head, git)
    inputs = {(root / row['path']).resolve(): row for row in bindings
              if (root / row['path']).is_dir() and (root / row['path']).resolve() == root / row['path']}
    before = inventory(root / 'node_modules', inputs)
    deps = owned / 'dependencies'; deps.mkdir(mode=0o700)
    copied = 0
    def bounded_copy(src, dst):
        nonlocal copied
        size = Path(src).stat().st_size
        if size > MAX_FILE_BYTES or copied + size > MAX_BYTES:
            raise ValueError('snapshot copy capacity exceeded')
        with open(src, 'rb') as incoming, open(dst, 'wb') as outgoing:
            file_bytes = 0
            while chunk := incoming.read(1024 * 1024):
                file_bytes += len(chunk); copied += len(chunk)
                if file_bytes > MAX_FILE_BYTES or copied > MAX_BYTES:
                    raise ValueError('snapshot copy capacity exceeded')
                outgoing.write(chunk)
        shutil.copystat(src, dst)
        return dst
    shutil.copytree(root / 'node_modules', deps / 'node_modules', symlinks=True, copy_function=bounded_copy)
    # Targets come from the Git archive, never the live workspace or ignored build output.
    for row in bindings:
        target = deps / row['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source / row['path'], target, copy_function=bounded_copy)
    outputs = {(deps / row['path']).resolve(): row for row in bindings}
    if os.geteuid() == 0:
        for base in (source, deps):
            for item in [base, *base.rglob('*')]:
                os.chown(item, custody_stat.st_uid, custody_stat.st_gid, follow_symlinks=False)
    after = inventory(deps / 'node_modules', outputs)
    if before != after or before != inventory(root / 'node_modules', inputs):
        raise ValueError('dependency bytes changed during custody transfer')
    record = {'schema': 'MCAppE2ECustody/v1', 'head': head,
              'source_tree_oid': git('rev-parse', head+'^{tree}').decode().strip(),
              'workspace_declaration': ({'path':'pnpm-workspace.yaml',
                  'git_blob':git('rev-parse', head+':pnpm-workspace.yaml').decode().strip(),
                  'sha256':file_digest(source/'pnpm-workspace.yaml')} if (source/'pnpm-workspace.yaml').exists() else None),
              'lock_blob_oid':git('rev-parse', head+':pnpm-lock.yaml').decode().strip(),
              'source_archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'source_inventory': inventory(source),
              'generated_support': [{'path': 'node_modules', 'type': 'directory',
                  'mode': 0o755, 'purpose': 'read-only nested dependency bind destination'}],
              'lock_sha256': hashlib.sha256((source / 'pnpm-lock.yaml').read_bytes()).hexdigest(),
              'dependency_inventory': after, 'workspace_bindings': bindings,
              'limits': {'bytes': MAX_BYTES, 'entries': MAX_ENTRIES, 'single_file_bytes': MAX_FILE_BYTES}}
    (owned / 'custody.json').write_text(json.dumps(record, sort_keys=True))
    print('APP_E2E_CUSTODY_SHA256=' + hashlib.sha256((owned / 'custody.json').read_bytes()).hexdigest())

def verify(owned, expected_digest):
    raw = (owned / 'custody.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_digest:
        raise ValueError('custody record changed during execution')
    record = json.loads(raw)
    if inventory(owned / 'source') != record['source_inventory']:
        raise ValueError('private source changed during execution')
    deps = owned / 'dependencies'
    outputs = {(deps / row['path']).resolve(): row for row in record['workspace_bindings']}
    if inventory(deps / 'node_modules', outputs) != record['dependency_inventory']:
        raise ValueError('private dependencies changed during execution')
    for row in record['workspace_bindings']:
        if inventory(deps / row['path']) != inventory(owned / 'source' / row['path']):
            raise ValueError('private workspace changed during execution')
    print('APP_E2E_CUSTODY_VERIFIED=' + expected_digest)


if __name__ == '__main__':
    if sys.argv[1] == '--verify':
        verify(Path(sys.argv[2]), sys.argv[3])
    else:
        export(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
