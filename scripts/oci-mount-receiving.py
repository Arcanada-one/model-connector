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


# Source handoff: integrate this function into existing scripts/oci-mount-receiving.py.
# Uses its existing bounded command and exact-head reconcile module; no separate job/helper.
PRIME_BASE = "library/node:24@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0"
PRIME_SOURCE = "e89329d0b099471f19de7c16e59f87cdc46f70a2"
PYTHON_READBACK = r"""import hashlib,json,os,pathlib,stat,sys
p=pathlib.Path(sys.executable).resolve(strict=True)
with p.open("rb") as f:
 before=os.fstat(f.fileno()); data=f.read(32*1024*1024+1); after=os.fstat(f.fileno())
if not stat.S_ISREG(before.st_mode) or len(data)>32*1024*1024 or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or len(data)!=before.st_size or os.geteuid()!=1000: sys.exit(42)
print(json.dumps({"schema":"PrimePythonExecutableBytes/v1","requested_path":"/usr/bin/python3","sys_executable":sys.executable,"real_path":str(p),"python_version":list(sys.version_info[:3]),"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),"euid":os.geteuid()},sort_keys=True))
"""


def exact_prime_missing_reference(code, raw):
    """Only one bounded Docker missing-image envelope proves frozen-reference absence."""
    import re
    if type(code) is not int or code != 1:
        return None
    # inspect may print an empty JSON result before its daemon error. No arbitrary
    # extra text, mixed permission/timeout error or second reference is accepted.
    match = re.fullmatch(rb'\s*(?:\[\]\s*)?(?:Error response from daemon: |Error: )?No such image: ([^\s]+)\s*', raw)
    accepted = {PRIME_BASE.encode(): 'literal', PRIME_BASE.removeprefix('library/').encode(): 'docker_hub_familiar'}
    return accepted.get(match.group(1)) if match else None


def prime_python_probe(owned, head, reconcile):
    # Globals reused from the reviewed existing OCI module: command, json, hashlib,
    # secrets, Path. All native stdout/stderr are finite private capture files.
    case = owned / "prime-python"; case.mkdir(mode=0o700)
    result = {"schema":"PrimeBasePythonReceiving/v1","executor_head":head,
              "prime_source":PRIME_SOURCE,"requested_image":PRIME_BASE,
              "probe_code_sha256":hashlib.sha256(PYTHON_READBACK.encode()).hexdigest(),
              "verdict":"NOT_MEASURED","python":None,"cleanup_exit_code":None,
              "runtime_authorized":False,"deployment_authorized":False}
    intent = False; primary = None; image = None; owner = None; name = None
    try:
        code, raw, labels = command(["docker","image","inspect",PRIME_BASE],case/"image.log",timeout=6)
        result["image_inspect_exit"] = code
        result['image_inspect_raw_sha256'] = hashlib.sha256(raw).hexdigest()
        result['image_inspect_requested_reference_seen'] = PRIME_BASE.encode() in raw
        missing_binding = exact_prime_missing_reference(code, raw)
        result['image_inspect_missing_reference_binding'] = missing_binding
        result['image_inspect_failure_codes'] = labels + (
            ['image_missing'] if b'no such image' in raw.lower() else [])
        if code:
            # Acquire only this frozen public base, in the existing CI probe.
            # Unknown daemon/permission/timeout failures never trigger acquisition.
            absent = missing_binding is not None
            if not absent:
                result["reason"] = "PINNED_BASE_CACHE_LOOKUP_FAILED"; return result
            pull, pull_raw, _ = command(
                ["docker", "image", "pull", "--platform=linux/amd64", PRIME_BASE],
                case/"acquire.log", timeout=90)
            result.update(acquisition_exit=pull,
                          acquisition_raw_sha256=hashlib.sha256(pull_raw).hexdigest(),
                          acquisition_platform="linux/amd64")
            if pull:
                result["reason"] = "PINNED_BASE_ACQUISITION_FAILED"; return result
            code, raw, _ = command(["docker", "image", "inspect", PRIME_BASE],
                                   case/"acquired-image.log", timeout=6)
            result["acquired_image_inspect_exit"] = code
            if code:
                result["reason"] = "PINNED_BASE_ACQUIRED_LOOKUP_FAILED"; return result
        objects = json.loads(raw)
        if len(objects)!=1: raise ValueError("image ambiguity")
        obj=objects[0]; image=obj["Id"]
        if not __import__("re").fullmatch(r"sha256:[a-f0-9]{64}",image) or obj["Os"]!="linux" or obj["Architecture"]!="amd64": raise ValueError("image identity/platform")
        digest=PRIME_BASE.split("@",1)[1]
        accepted={"node@"+digest,"library/node@"+digest,"docker.io/library/node@"+digest}
        if not accepted.intersection(obj.get("RepoDigests") or []): raise ValueError("requested digest missing")
        result.update(image_id=image,image_os="linux",image_architecture="amd64",repo_digest=digest)
        owner="mc-prime-python-"+secrets.token_hex(16); name=owner+"-app"
        reconcile.write(case/"app.intent.json",{"role":"app","owner":owner,"head":head,"name":name,"state":"in_flight"});intent=True
        argv=["docker","create","--pull=never","--name",name,"--cidfile",str(case/"app.cid"),
              "--label","mc-run="+owner,"--label","mc-role=app","--label","mc-head="+head,
              "--user","1000:1000","--network=none","--cpus=.25","--memory=128m","--pids-limit=32",
              "--read-only","--cap-drop=ALL","--security-opt=no-new-privileges",
              "--entrypoint","/usr/bin/python3",image,"-I","-B","-c",PYTHON_READBACK]
        code,raw,labels=command(argv,case/"create.log",timeout=6)
        cid=(case/"app.cid").read_text().strip() if (case/"app.cid").exists() else ""
        reconcile.write(case/"app.response.json",{"code":code,"id":cid})
        result["create_exit"]=code
        if code or not __import__("re").fullmatch(r"[a-f0-9]{64}",cid):
            result["reason"]="CONTAINER_CREATE_NOT_MEASURED";return result
        code,raw,labels=command(["docker","start","-a",cid],case/"start.log",timeout=6)
        result.update(start_exit=code,failure_codes=labels,start_raw_sha256=hashlib.sha256(raw).hexdigest())
        if code: result["reason"]="PYTHON_EXECUTION_NOT_MEASURED";return result
        measured=json.loads(raw)
        # No report accepts a checksum without exact executable/path/user/version bindings.
        required={"schema","requested_path","sys_executable","real_path","python_version","bytes","sha256","euid"}
        if set(measured)!=required or measured["schema"]!="PrimePythonExecutableBytes/v1" or measured["requested_path"]!="/usr/bin/python3" or measured["sys_executable"]!="/usr/bin/python3" or not measured["real_path"].startswith("/usr/") or measured["euid"]!=1000 or not isinstance(measured["bytes"],int) or measured["bytes"]<=0 or measured["bytes"]>32*1024*1024 or not __import__("re").fullmatch(r"[a-f0-9]{64}",measured["sha256"]): raise ValueError("python binding")
        if not isinstance(measured["python_version"],list) or len(measured["python_version"])!=3 or any(type(v)!=int for v in measured["python_version"]) or measured["python_version"][0]!=3:raise ValueError("version")
        code,inspect_raw,_=command(["docker","inspect",cid],case/"inspect.log",timeout=6)
        if code:raise ValueError("inspection unavailable")
        inspected=json.loads(inspect_raw)
        if len(inspected)!=1:raise ValueError("inspection ambiguity")
        obj=inspected[0]; config=obj["Config"];host=obj["HostConfig"]
        expected={"mc-run":owner,"mc-role":"app","mc-head":head}
        if obj["Id"]!=cid or obj["Name"].lstrip("/")!=name or obj["Image"]!=image or any(config.get("Labels",{}).get(k)!=v for k,v in expected.items()) or config["User"]!="1000:1000" or host["NetworkMode"]!="none" or host["ReadonlyRootfs"] is not True or "ALL" not in host["CapDrop"] or "no-new-privileges" not in host["SecurityOpt"] or host.get("PortBindings") or host["PidsLimit"]!=32 or obj["Mounts"]:raise ValueError("container restrictions")
        result.update(python=measured,restrictions_verified=True,verdict="MEASURED_PENDING_CLEANUP")
    except (OSError,ValueError,KeyError,TypeError,__import__("subprocess").SubprocessError):
        primary="receiving_exception";result.update(reason=primary,verdict="NOT_MEASURED")
    finally:
        if intent:
            try: result["cleanup_exit_code"]=reconcile.reconcile(case)
            except (OSError,ValueError,KeyError,TypeError,__import__("subprocess").SubprocessError):result["cleanup_exit_code"]=127
            if result["cleanup_exit_code"]!=0:result.update(reason="CLEANUP_UNKNOWN",verdict="NOT_MEASURED")
            elif result["verdict"]=="MEASURED_PENDING_CLEANUP":result["verdict"]="VERIFIED_EXECUTABLE_BYTES_ONLY"
        # On any refusal retain private logs/intents, no cache pull or retry.
        (case/"receipt.json").write_text(json.dumps(result,sort_keys=True,indent=2)+"\n")
    return result


def git(root, *arguments):
    # Same protected Git environment as Program native_projection.git.
    environment = {'PATH':'/usr/bin:/bin','HOME':'/nonexistent',
        'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null',
        'GIT_NO_REPLACE_OBJECTS':'1','GIT_TERMINAL_PROMPT':'0'}
    return subprocess.check_output(['/usr/bin/git','--no-optional-locks','-c','core.fsmonitor=false',
        '-c','core.hooksPath=/dev/null',*arguments],cwd=root,env=environment,timeout=3)


def helper_binding(root, head, name):
    entries=git(root,'ls-tree','-z',head,'--',name).split(b'\0')[:-1]
    if len(entries)!=1: raise ValueError('helper source membership absent')
    metadata,path=entries[0].decode().split('\t');mode,kind,blob=metadata.split()
    if path!=name or mode!='100644' or kind!='blob': raise ValueError('helper Git mode/type refused')
    raw=git(root,'cat-file','blob',blob)
    if hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()!=blob:
        raise ValueError('helper Git object digest mismatch')
    return raw,{'path':name,'mode':mode,'git_blob':blob,'sha256':hashlib.sha256(raw).hexdigest()}


def old_mount_refusal(row):
    # docker start -a reports the observed runtime mount refusal as 1; some
    # Docker versions report 125. Neither status alone establishes the cause.
    return (row['variant'] == 'old_missing' and row['phase'] == 'start'
        and type(row['exit_code']) is int and row['exit_code'] in (1, 125)
        and {'read_only_filesystem', 'oci_runtime'}.issubset(row['failure_codes'])
        and row['mount_destination_seen'] is True
        and row['restrictions_verified'] is True and row['received'] is False
        and row['primary_exception'] is None)


def main():
    if os.getuid() == 0: raise ValueError("nonroot executor required")
    root = Path.cwd()
    head = git(root,'rev-parse','HEAD').decode().strip()
    image = subprocess.check_output(['docker', 'image', 'inspect', 'model-connector-e2e:latest',
                                     '--format', '{{.Id}}'], timeout=3).decode().strip()
    if not __import__('re').fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('immutable cached image absent')
    owned = Path(tempfile.mkdtemp(prefix='mc-oci-receiving-', dir=os.environ['RUNNER_TEMP']))
    source, reconcile_binding = helper_binding(root,head,'scripts/app-e2e-reconcile.py')
    helper = owned / 'reconcile.py'; helper.write_bytes(source)
    spec = importlib.util.spec_from_file_location('owned_reconcile', helper)
    reconcile = importlib.util.module_from_spec(spec); spec.loader.exec_module(reconcile)
    snapshot_raw, snapshot_binding = helper_binding(root,head,'scripts/app-e2e-snapshot.py')
    snapshot_path = owned / 'snapshot.py'; snapshot_path.write_bytes(snapshot_raw)
    spec = importlib.util.spec_from_file_location('owned_snapshot', snapshot_path)
    snapshot = importlib.util.module_from_spec(spec); spec.loader.exec_module(snapshot)
    prime = prime_python_probe(owned,head,reconcile)
    prime['upstream_source_sha256'] = '752e3c40a554e8fc3bc317caef5aff3d511e0643ab465914792822c5799dbb89'
    prime['producer_source_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    prime['source_bindings'] = [reconcile_binding,snapshot_binding]
    (Path(os.environ['RUNNER_TEMP'])/'prime-base-python-receiving.json').write_text(json.dumps(prime,indent=2))
    if prime.get('cleanup_exit_code') not in (None,0):
        return 1
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
              'source_bindings':[reconcile_binding,snapshot_binding],
              'reconcile_sha256':hashlib.sha256(source).hexdigest(),
              'snapshot_sha256':hashlib.sha256(snapshot_raw).hexdigest(),'results':rows,
              'app_executions':0,'provider_calls':0}
    target = Path(os.environ['RUNNER_TEMP'])/'mc-oci-mount-receiving.json'
    target.write_text(json.dumps(result,indent=2))
    if len(rows) != 2:
        result['hypothesis'] = 'NOT_MEASURED'
        target.write_text(json.dumps(result,indent=2)); print(target.read_text()); return 1
    old_red = old_mount_refusal(rows[0])
    result['hypothesis'] = 'SUPPORTED' if old_red else 'REFUTED' if rows[0]['received'] else 'NOT_MEASURED'
    target.write_text(json.dumps(result,indent=2)); print(target.read_text())
    return 0 if old_red and rows[1]['received'] and all(r['cleanup_exit_code']==0 and r['projection_unchanged'] for r in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
