"""Candidate crash instrument; call only after independent freeze/resource admission.

Only the existing ledger implementation is exported from its exact Git object.
No oracle, input packet parent directory or provider adapter is loaded.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

LEDGER_COMMIT = 'ca645ea29dd8f16341eec9a818e1f2db60f71886'
LEDGER_PATH = 'tools/science/a2p16_diagnostic/ledger.py'
LEDGER_SHA256 = '7b749acb6dce75b75d92c87e1f39109022fc4123e535159ff024aee59f6774e9'


def load_ledger(path):
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != LEDGER_SHA256:
        raise ValueError('ledger dependency custody mismatch')
    spec = importlib.util.spec_from_file_location('df60_owned_ledger', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def observe_crashed_ledger(source_repo, owned):
    """Actual owned process termination and durable ledger observation; no assertions/oracle."""
    owned = Path(owned)
    if owned.is_symlink():
        raise ValueError('custody directory indirection refused')
    owned = owned.resolve(strict=True)
    if list(owned.iterdir()):
        raise ValueError('exclusive empty custody directory required')
    raw = subprocess.check_output(['git', '-C', str(source_repo), 'show',
                                   LEDGER_COMMIT + ':' + LEDGER_PATH], timeout=10)
    if hashlib.sha256(raw).hexdigest() != LEDGER_SHA256:
        raise ValueError('immutable ledger source mismatch')
    dependency = owned / 'ledger.py'
    dependency.write_bytes(raw)
    module = load_ledger(dependency)
    ledger_path = owned / 'exposure.sqlite'
    manifest = {'ledger_path': str(ledger_path), 'ceiling_micro_usd': 2,
                'expires_at': time.time() + 120,
                'pins': {'ledger_sha256': LEDGER_SHA256},
                'schedule': [{'id': 'crashed', 'max_micro_usd': 1},
                             {'id': 'next', 'max_micro_usd': 1}]}
    (owned / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True))
    ledger = module.Ledger.create(ledger_path, manifest)
    identity = (ledger_path.stat().st_dev, ledger_path.stat().st_ino)
    child = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()),
                              '--reserved-child', str(owned)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env={'PATH': '/usr/bin:/bin'},
                             start_new_session=True)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=10):
                raise ValueError('durable reserve barrier timeout')
            if child.stdout.readline() != b'RESERVED\n':
                raise ValueError('durable reserve barrier absent')
        # The child is blocked on stdin after reserve committed. Kill only this PID.
        child.kill()
        code = child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill(); child.wait(timeout=5)
        for pipe in (child.stdin, child.stdout, child.stderr):
            pipe.close()
    if (ledger_path.stat().st_dev, ledger_path.stat().st_ino) != identity:
        raise ValueError('ledger was replaced across crash')
    reopened = module.Ledger(ledger_path, manifest)
    before = reopened.snapshot()
    marker = owned / 'invoked'
    def invoke(attempt):
        marker.write_text(attempt)
        raise RuntimeError('unexpected fixture invocation')
    refusal = None
    try:
        reopened.dispatch_once('next', manifest['pins'], invoke)
    except module.Stop as error:
        refusal = str(error)
    return {'schema': 'MCActualCrashLedgerObservation/v1',
            'dependency_commit': LEDGER_COMMIT, 'dependency_sha256': LEDGER_SHA256,
            'child_exit_code': code, 'same_ledger_identity': True,
            'before_next_dispatch': before, 'after_next_dispatch': reopened.snapshot(),
            'dispatch_refusal': refusal, 'invocation_marker_present': marker.exists(),
            'paid_provider_calls': 0, 'admission': 'NOT_MEASURED'}


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--reserved-child':
        raise SystemExit('No standalone measurement entrypoint; independent receiving admission required')
    owned = Path(sys.argv[2]).resolve(strict=True)
    module = load_ledger(owned / 'ledger.py')
    manifest = json.loads((owned / 'manifest.json').read_text())
    ledger = module.Ledger(owned / 'exposure.sqlite', manifest)
    ledger.reserve('crashed', manifest['pins'])
    print('RESERVED', flush=True)
    # Parent termination occurs here, before any adapter invocation.
    sys.stdin.buffer.read(1)
    raise SystemExit('unexpected barrier release')
