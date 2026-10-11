"""Durable creation intents and exclusive-label cleanup; uncertainty preserves custody."""
import json, os, re, subprocess, sys
from pathlib import Path
HEX = re.compile(r'[a-f0-9]{64}')


def write(path, doc):
    temporary = path.with_suffix('.new')
    with temporary.open('x') as stream:
        json.dump(doc, stream); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=3)
    if result.returncode: raise ValueError('Docker receiving unavailable')
    return result.stdout.strip()


def reconcile(owned):
    outcomes = []; failed = False
    for role in ('app', 'redis', 'pg', 'network'):
        path = owned / (role + '.intent.json')
        if not path.exists(): continue
        intent = json.loads(path.read_text())
        network = role == 'network'
        listing = ('network', 'ls') if network else ('ps',)
        filters = ['--filter', 'label=mc-run='+intent['owner'], '--filter', 'label=mc-role='+role]
        try:
            ids = docker(*listing, '-q', '--no-trunc', *([] if network else ['-a']), *filters).split()
            if len(ids) > 1 or any(not HEX.fullmatch(i) for i in ids):
                raise ValueError('ambiguous owned inventory')
            response = owned / (role + '.response.json')
            returned = json.loads(response.read_text()) if response.exists() else {}
            cid = owned / (role + '.cid')
            received = returned.get('id') or (cid.read_text().strip() if cid.exists() else '')
            if received and not HEX.fullmatch(received): raise ValueError('invalid received identity')
            if ids:
                identity = ids[0]
                if received and received != identity: raise ValueError('identity mismatch')
                raw = docker(*(['network', 'inspect'] if network else ['inspect']), identity)
                objects = json.loads(raw)
                if len(objects) != 1: raise ValueError('ambiguous inspection')
                obj = objects[0]; labels = obj.get('Labels', {}) if network else obj.get('Config', {}).get('Labels', {})
                if (obj.get('Id') != identity or obj.get('Name', '').lstrip('/') != intent['name'] or
                    any(labels.get(k) != v for k,v in {'mc-run':intent['owner'],'mc-role':role,'mc-head':intent['head']}.items())):
                    raise ValueError('foreign ownership collision')
                docker(*(['network', 'rm'] if network else ['rm', '-f']), identity)
                if docker(*listing, '-q', '--no-trunc', *([] if network else ['-a']), *filters):
                    raise ValueError('owned residual remains')
            elif returned.get('code') != 0:
                # Empty inventory after a lost response cannot prove the operation settled.
                raise ValueError('creation completion unknown')
            outcomes.append({'role':role,'verdict':'absence_verified'})
        except (ValueError, OSError, KeyError, subprocess.TimeoutExpired, json.JSONDecodeError):
            failed = True; outcomes.append({'role':role,'verdict':'UNKNOWN'})
    write(owned / 'cleanup.json', {'outcomes':outcomes,'verdict':'UNKNOWN' if failed else 'absence_verified'})
    print('APP_E2E_CLEANUP='+('UNKNOWN' if failed else 'absence_verified'))
    return 127 if failed else 0


if __name__ == '__main__':
    mode, folder = sys.argv[1:3]; owned=Path(folder)
    if mode == 'intent':
        role, owner, head, name = sys.argv[3:7]
        write(owned/(role+'.intent.json'), {'role':role,'owner':owner,'head':head,'name':name,'state':'in_flight'})
    elif mode == 'response':
        role, code, identity = sys.argv[3:6]
        write(owned/(role+'.response.json'), {'code':int(code),'id':identity.strip()})
    elif mode == 'cleanup': sys.exit(reconcile(owned))
    else: raise ValueError('unsupported operation')
