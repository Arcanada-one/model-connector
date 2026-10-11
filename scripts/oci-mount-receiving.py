"""Bounded same-job OCI receiving probe; no App, stores, network or provider access."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import resource
import subprocess
import sys
import tempfile


def command(argv, log, timeout=6):
    def limit(): resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024, 128 * 1024))
    with log.open('xb') as output:
        try:
            result = subprocess.run(argv, stdout=output, stderr=subprocess.STDOUT,
                                    timeout=timeout, preexec_fn=limit)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = 124
    raw = log.read_bytes()
    codes = [label for needle, label in (
        (b'read-only file system', 'read_only_filesystem'),
        (b'permission denied', 'permission_denied'),
        (b'invalid mount', 'invalid_mount'),
        (b'OCI runtime', 'oci_runtime')) if needle.lower() in raw.lower()]
    if len(raw) >= 128 * 1024: code = 124; codes.append('capture_capacity')
    return code, raw, codes


def restrictions(obj, owner, name, head, image, src, deps):
    config, host = obj['Config'], obj['HostConfig']
    return (obj['Name'].lstrip('/') == name and obj['Image'] == image
        and config['Labels'] == {'mc-run': owner, 'mc-role': 'app', 'mc-head': head}
        and config['User'] == str(os.getuid())+':'+str(os.getgid())
        and host['NetworkMode'] == 'none' and host['ReadonlyRootfs'] is True
        and 'ALL' in host['CapDrop'] and 'no-new-privileges' in host['SecurityOpt']
        and not host.get('PortBindings') and host['PidsLimit'] == 32
        and len(obj['Mounts']) == 2
        and {(m['Source'],m['Destination'],m['RW']) for m in obj['Mounts']}
            == {(str(src),'/work',False),(str(deps),'/work/node_modules',False)})


def main():
    if os.getuid() == 0: raise ValueError("nonroot executor required")
    root = Path.cwd()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], timeout=3).decode().strip()
    image = subprocess.check_output(['docker', 'image', 'inspect', 'model-connector-e2e:latest',
                                     '--format', '{{.Id}}'], timeout=3).decode().strip()
    if not __import__('re').fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('immutable cached image absent')
    owned = Path(tempfile.mkdtemp(prefix='mc-oci-receiving-', dir=os.environ['RUNNER_TEMP']))
    source = subprocess.check_output(['git', 'show', head + ':scripts/app-e2e-reconcile.py'], timeout=3)
    helper = owned / 'reconcile.py'; helper.write_bytes(source)
    spec = importlib.util.spec_from_file_location('owned_reconcile', helper)
    reconcile = importlib.util.module_from_spec(spec); spec.loader.exec_module(reconcile)
    snapshot_raw = subprocess.check_output(['git', 'show', head + ':scripts/app-e2e-snapshot.py'], timeout=3)
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
        before_source, before_deps = snapshot.inventory(src), snapshot.inventory(deps)
        owner = 'mc-oci-' + secrets.token_hex(16); name = owner + '-app'
        reconcile.write(case / 'app.intent.json',
                        {'role': 'app', 'owner': owner, 'head': head, 'name': name, 'state': 'in_flight'})
        argv = ['docker', 'create', '--pull=never', '--name', name, '--cidfile', str(case/'app.cid'),
                '--label', 'mc-run='+owner, '--label', 'mc-role=app', '--label', 'mc-head='+head,
                '--network=none', '--cpus=.25', '--memory=128m', '--user', str(os.getuid())+':'+str(os.getgid()),
                '--pids-limit=32', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                '-v', str(src)+':/work:ro', '-v', str(deps)+':/work/node_modules:ro',
                '-w', '/work', '--entrypoint', '/bin/sh', image,
                '-c', 'env -i PATH=/usr/local/bin:/usr/bin:/bin node -e \'const f=require("fs");if(process.getuid()===0)process.exit(42);if(f.readFileSync("node_modules/probe","utf8")!=="MC_OCI_BOUND_DEPENDENCY")process.exit(43);for(const p of ["/work/probe-write","/work/node_modules/probe-write"]){try{f.writeFileSync(p,"x");process.exit(44)}catch(e){if(!["EROFS","EACCES"].includes(e.code))process.exit(45)}}console.log("MC_OCI_RECEIVED")\'']
        code, raw, labels, phase, receiving = 127, b'', ['receiving_exception'], 'create', False
        primary_exception = None
        try:
            code, raw, labels = command(argv, case/'create.log')
            identity = (case/'app.cid').read_text().strip() if (case/'app.cid').exists() else ''
            reconcile.write(case/'app.response.json', {'code':code, 'id':identity})
            phase = 'create'
            if code == 0:
                if not __import__('re').fullmatch(r'[a-f0-9]{64}', identity):
                    raise ValueError('exact created identity absent')
                phase = 'start'
                code, raw, labels = command(['docker', 'start', '-a', identity], case/'start.log')
            receiving = False
            if identity:
                inspect_code, inspected, _ = command(['docker', 'inspect', identity], case/'inspect.log')
                if inspect_code == 0:
                    try:
                        objects = json.loads(inspected)
                        receiving = len(objects) == 1 and restrictions(objects[0],owner,name,head,image,src,deps)
                    except (ValueError, KeyError, TypeError): pass
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            primary_exception = 'receiving_exception'
        finally:
            try:
                cleanup = reconcile.reconcile(case)
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                cleanup = 127
        # Unknown custody remains on disk; no removal of the projection or intents.
        rows.append({'variant':variant,'phase':phase,'exit_code':code,
                     'failure_codes':labels,'mount_destination_seen':b'/work/node_modules' in raw,'raw_sha256':hashlib.sha256(raw).hexdigest(),
                     'received':code == 0 and raw.strip() == b'MC_OCI_RECEIVED' and receiving,
                     'restrictions_verified':receiving,
                     'projection_unchanged':before_source == snapshot.inventory(src) and before_deps == snapshot.inventory(deps),
                     'cleanup_exit_code':cleanup,'primary_exception':primary_exception})
        if cleanup or code == 124 or primary_exception: break
    result = {'schema':'MCNativeOCIMountReceiving/v1','head':head,'image_id':image,
              'reconcile_sha256':hashlib.sha256(source).hexdigest(),
              'snapshot_sha256':hashlib.sha256(snapshot_raw).hexdigest(),'results':rows,
              'app_executions':0,'provider_calls':0}
    target = Path(os.environ['RUNNER_TEMP'])/'mc-oci-mount-receiving.json'
    target.write_text(json.dumps(result,indent=2))
    if len(rows) != 2:
        result['hypothesis'] = 'NOT_MEASURED'
        target.write_text(json.dumps(result,indent=2)); print(target.read_text()); return 1
    old_red = (rows[0]['phase'] == 'start' and rows[0]['exit_code'] == 125
               and 'read_only_filesystem' in rows[0]['failure_codes']
               and rows[0]['mount_destination_seen']
               and rows[0]['restrictions_verified'])
    result['hypothesis'] = 'SUPPORTED' if old_red else 'REFUTED' if rows[0]['received'] else 'NOT_MEASURED'
    target.write_text(json.dumps(result,indent=2)); print(target.read_text())
    return 0 if old_red and rows[1]['received'] and all(r['cleanup_exit_code']==0 and r['projection_unchanged'] for r in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
