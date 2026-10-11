"""Export pinned Git bytes and separately copy byte-bound owned dependencies."""
import fnmatch, hashlib, json, os, re, shutil, subprocess, sys, tarfile
from pathlib import Path


def inventory(root, workspaces=None):
    workspaces = workspaces or {}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('dependency root indirection or absence')
    rows = []
    for path in sorted(root.rglob('*')):
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
            rows.append([name, 'file', hashlib.sha256(path.read_bytes()).hexdigest()])
        elif not path.is_dir():
            raise ValueError('unsupported dependency object')
    return rows


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
    bindings = workspace_bindings(source, head, git)
    inputs = {(root / row['path']).resolve(): row for row in bindings
              if (root / row['path']).is_dir() and (root / row['path']).resolve() == root / row['path']}
    before = inventory(root / 'node_modules', inputs)
    deps = owned / 'dependencies'; deps.mkdir(mode=0o700)
    shutil.copytree(root / 'node_modules', deps / 'node_modules', symlinks=True)
    # Targets come from the Git archive, never the live workspace or ignored build output.
    for row in bindings:
        target = deps / row['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source / row['path'], target)
    outputs = {(deps / row['path']).resolve(): row for row in bindings}
    if os.geteuid() == 0:
        for base in (source, deps):
            for item in [base, *base.rglob('*')]:
                os.chown(item, custody_stat.st_uid, custody_stat.st_gid, follow_symlinks=False)
    after = inventory(deps / 'node_modules', outputs)
    if before != after or before != inventory(root / 'node_modules', inputs):
        raise ValueError('dependency bytes changed during custody transfer')
    record = {'schema': 'MCAppE2ECustody/v1', 'head': head,
              'source_archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'source_inventory': inventory(source),
              'lock_sha256': hashlib.sha256((source / 'pnpm-lock.yaml').read_bytes()).hexdigest(),
              'dependency_inventory': after, 'workspace_bindings': bindings}
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
