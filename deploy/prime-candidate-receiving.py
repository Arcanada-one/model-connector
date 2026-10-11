"""Source-candidate observation checker; no Docker, network, grant or actuator."""
import argparse
import json
import re
from pathlib import Path


class Refusal(ValueError):
    pass


def check(record, source_sha, image_id):
    if not re.fullmatch(r'[a-f0-9]{40}', source_sha) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
        raise Refusal('identity')
    if record.get('sourceRevision') != source_sha or record.get('imageId') != image_id or record.get('verdict') != 'MEASURED':
        raise Refusal('binding')
    if record.get('runtime_authorized') is not False or record.get('provider_authorized') is not False:
        raise Refusal('authority')
    image = record['imageInspect']
    config = image['Config']
    if (image['Id'] != image_id or image['Os'] != 'linux' or image['Architecture'] != 'amd64'
            or config['User'] != '1000:1000' or config['WorkingDir'] != '/app'
            or config['Cmd'] != ['node', 'tools/prime_service.mjs']
            or config['Entrypoint'] != ['docker-entrypoint.sh']
            or config['Labels'] != {'org.opencontainers.image.revision': source_sha}
            or len(config['Env']) != 4
            or set(x.split('=',1)[0] for x in config['Env']) != {'PATH','NODE_VERSION','YARN_VERSION','PRIME_SOURCE_REVISION'}
            or 'PRIME_SOURCE_REVISION=' + source_sha not in config['Env']
            or not any(x.startswith('NODE_VERSION=24.') for x in config['Env'])):
        raise Refusal('image_configuration')
    c = record['containerInspect']; h = c['HostConfig']
    if (c['Id'] != record['containerId'] or c['Image'] != image_id
            or c['Config']['User'] != '1000:1000' or not c['State']['Running']
            or h['NetworkMode'] != 'none' or not h['ReadonlyRootfs']
            or h['Privileged'] or h['CapAdd'] or h['CapDrop'] != ['ALL']
            or h['SecurityOpt'] != ['no-new-privileges'] or h['PortBindings']
            or h['Binds'] or c['Mounts'] or h['Memory'] != 134217728
            or h['NanoCpus'] != 250000000 or h['PidsLimit'] != 32
            or h['Tmpfs'] != {'/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777'}):
        raise Refusal('container_configuration')
    expected_health = {'status':'ok', 'version':source_sha, 'service':'prime-agent',
                       'scope':'process_liveness', 'runtime_authorized':False}
    expected_ready = {'status':'paused', 'version':source_sha, 'service':'prime-agent',
                      'runtime_authorized':False, 'knowledge_admitted':False,
                      'dependencies':{x:'NOT_MEASURED' for x in
                        ['database','native_admission','budget_accounting','credential_custody','restore']}}
    if json.dumps(record['http'],sort_keys=True) != json.dumps( [{'path':'/health','status':200,'body':expected_health},
                          {'path':'/ready','status':503,'body':expected_ready}],sort_keys=True):
        raise Refusal('health_boundary')
    if record.get('containerTeardown') != 'PASS' or record.get('imageTeardown') not in ('PASS','PRESERVED_CANDIDATE'):
        raise Refusal('owned_teardown')
    return {'schema':'PrimeCandidateReceiving/v1','sourceRevision':source_sha,
            'imageId':image_id,'verdict':'SOURCE_CANDIDATE_OBSERVATIONS_PASS',
            'scope':'local_process_liveness_only','runtime_authorized':False,
            'deployment_authorized':False,'provider_authorized':False,
            'production_readiness':'NOT_MEASURED','registryImage':None}


def main():
    p=argparse.ArgumentParser();p.add_argument('record',type=Path)
    p.add_argument('--source-sha',required=True);p.add_argument('--image-id',required=True)
    a=p.parse_args()
    try:
        with a.record.open('rb') as stream:raw=stream.read(65537)
        if len(raw)>65536:raise Refusal('capture_bound')
        def unique(pairs):
            d={}
            for k,v in pairs:
                if k in d:raise Refusal('duplicate_key')
                d[k]=v
            return d
        result=check(json.loads(raw,object_pairs_hook=unique),a.source_sha,a.image_id)
    except (ValueError,KeyError,TypeError,OSError,RecursionError):
        print(json.dumps({'code':'PRIME_CANDIDATE_RECEIVING_REFUSED','runtime_authorized':False}));return 1
    print(json.dumps(result,sort_keys=True));return 0


if __name__=='__main__':
    raise SystemExit(main())
