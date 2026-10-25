"""Offline image custody check, never a financial authorization or activation gate."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

FILES = ('bench-account-receiving.py', 'bench-monetary-v2.disabled.json',
         'bench-receiving-package.py')
MANIFEST_SHA = 'a47725d16c63b78c9bac626f9cf387a4d92d66d6481c420924365b6da4c6ce36'
RECEIPT = 'bench-receiving-provenance.json'


def snapshot(root):
    hashes = {}
    for name in FILES:
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('package_file_invalid')
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if hashes['bench-monetary-v2.disabled.json'] != MANIFEST_SHA:
        raise ValueError('disabled_manifest_changed')
    # Immutable manifest digest includes all thirteen original NULL references.
    return hashes


def source_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('source_revision_required')
    return value


def seal(root, revision):
    receipt = {'schema': 'BenchReceivingImageProvenance/v1',
               'build_source': source_sha(revision), 'files': snapshot(root),
               'enabled': False, 'runtime_authorized': False}
    # Build-only, exclusive creation. No existing receipt is overwritten.
    with (root / RECEIPT).open('x', encoding='utf-8') as output:
        json.dump(receipt, output, sort_keys=True)
        output.write('\n')
    return receipt


def verify(root, expected_revision, installed_revision):
    expected = source_sha(expected_revision)
    if source_sha(installed_revision) != expected:
        raise ValueError('build_revision_mismatch')
    path = root / RECEIPT
    if path.is_symlink() or not path.is_file():
        raise ValueError('provenance_missing')
    receipt = json.loads(path.read_text())
    required = {'schema': 'BenchReceivingImageProvenance/v1',
                'build_source': expected, 'files': snapshot(root),
                'enabled': False, 'runtime_authorized': False}
    if receipt != required:
        raise ValueError('provenance_mismatch')
    spec = importlib.util.spec_from_file_location('bench_installed_receiver', root / FILES[0])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(spec.name, None)
    if module.PreparedAccountVerifier.runtime_authorized is not False:
        raise ValueError('receiver_authority_changed')
    return {'schema': 'BenchReceivingImageReadback/v1', 'build_source': expected,
            'files': receipt['files'], 'python_version': sys.version.split()[0],
            'python_binary_sha256': hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
            'enabled': False, 'runtime_authorized': False,
            'native_resolver': 'NOT_MEASURED', 'provider_calls': 0, 'journal_calls': 0}


def main():
    try:
        root = Path(__file__).resolve().parent
        if sys.argv[1:] == ['seal']:
            seal(root, os.environ.get('MC_BUILD_SHA'))
        elif len(sys.argv) == 3 and sys.argv[1] == 'verify':
            print(json.dumps(verify(root, sys.argv[2], os.environ.get('MC_BUILD_SHA')), sort_keys=True))
        else:
            raise ValueError('unsupported_operation')
    except Exception:
        # Never expose exception contents, file contents or authority references.
        print('disabled_receiver_package_refused', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
