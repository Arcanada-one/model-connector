"""Bounded same-job OCI receiving probe; no App, stores, network or provider access."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile


def command(argv, log, timeout=15):
    try:
        result = subprocess.run(argv, capture_output=True, timeout=timeout)
        code, raw = result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired as error:
        code, raw = 124, (error.stdout or b'') + (error.stderr or b'')
    log.write_bytes(raw)
    codes = [label for needle, label in (
        (b'read-only file system', 'read_only_filesystem'),
        (b'permission denied', 'permission_denied'),
        (b'invalid mount', 'invalid_mount'),
        (b'OCI runtime', 'oci_runtime')) if needle.lower() in raw.lower()]
    return code, raw, codes


def main():
    root = Path.cwd()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], timeout=5).decode().strip()
    image = subprocess.check_output(['docker', 'image', 'inspect', 'model-connector-e2e:latest',
                                     '--format', '{{.Id}}'], timeout=5).decode().strip()
    if not __import__('re').fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('immutable cached image absent')
    owned = Path(tempfile.mkdtemp(prefix='mc-oci-receiving-', dir=os.environ['RUNNER_TEMP']))
    source = subprocess.check_output(['git', 'show', head + ':scripts/app-e2e-reconcile.py'], timeout=5)
    helper = owned / 'reconcile.py'; helper.write_bytes(source)
    spec = importlib.util.spec_from_file_location('owned_reconcile', helper)
    reconcile = importlib.util.module_from_spec(spec); spec.loader.exec_module(reconcile)
    snapshot_raw = subprocess.check_output(['git', 'show', head + ':scripts/app-e2e-snapshot.py'], timeout=5)
    snapshot_path = owned / 'snapshot.py'; snapshot_path.write_bytes(snapshot_raw)
    spec = importlib.util.spec_from_file_location('owned_snapshot', snapshot_path)
    snapshot = importlib.util.module_from_spec(spec); spec.loader.exec_module(snapshot)
    rows = []
    for variant in ('old_missing', 'new_generated'):
        case = owned / variant; case.mkdir(mode=0o700)
        src = case / 'source'; src.mkdir(mode=0o755)
        deps = case / 'dependencies'; deps.mkdir(mode=0o755)
        (deps / 'probe').write_text('MC_OCI_BOUND_DEPENDENCY')
        if variant == 'new_generated': snapshot.dependency_mountpoint(src)
        owner = 'mc-oci-' + secrets.token_hex(16); name = owner + '-app'
        reconcile.write(case / 'app.intent.json',
                        {'role': 'app', 'owner': owner, 'head': head, 'name': name, 'state': 'in_flight'})
        argv = ['docker', 'create', '--pull=never', '--name', name, '--cidfile', str(case/'app.cid'),
                '--label', 'mc-run='+owner, '--label', 'mc-role=app', '--label', 'mc-head='+head,
                '--network=none', '--cpus=.25', '--memory=128m', '--user', str(os.getuid())+':'+str(os.getgid()),
                '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                '-v', str(src)+':/work:ro', '-v', str(deps)+':/work/node_modules:ro',
                '-w', '/work', '--entrypoint', '/bin/sh', image,
                '-c', 'env -i PATH=/usr/local/bin:/usr/bin:/bin node -e \'if(require("fs").readFileSync("node_modules/probe","utf8")!=="MC_OCI_BOUND_DEPENDENCY")process.exit(1); console.log("MC_OCI_RECEIVED")\'']
        code, raw, labels = command(argv, case/'create.log')
        identity = (case/'app.cid').read_text().strip() if (case/'app.cid').exists() else ''
        reconcile.write(case/'app.response.json', {'code':code, 'id':identity})
        phase = 'create'
        if code == 0:
            if not __import__('re').fullmatch(r'[a-f0-9]{64}', identity):
                raise ValueError('exact created identity absent')
            phase = 'start'
            code, raw, labels = command(['docker', 'start', '-a', identity], case/'start.log')
        cleanup = reconcile.reconcile(case)
        rows.append({'variant':variant,'phase':phase,'exit_code':code,
                     'failure_codes':labels,'raw_sha256':hashlib.sha256(raw).hexdigest(),
                     'received':code == 0 and raw.strip() == b'MC_OCI_RECEIVED',
                     'cleanup_exit_code':cleanup})
    result = {'schema':'MCNativeOCIMountReceiving/v1','head':head,'image_id':image,
              'reconcile_sha256':hashlib.sha256(source).hexdigest(),
              'snapshot_sha256':hashlib.sha256(snapshot_raw).hexdigest(),'results':rows,
              'app_executions':0,'provider_calls':0}
    target = Path(os.environ['RUNNER_TEMP'])/'mc-oci-mount-receiving.json'
    target.write_text(json.dumps(result,indent=2));print(target.read_text())
    return 0 if rows[1]['received'] and all(r['cleanup_exit_code']==0 for r in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
