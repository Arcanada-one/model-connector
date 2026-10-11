"""Independent rendered fixture and refusal controls; no Docker daemon calls."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).parent
HELPER = ROOT / 'prime-compose-contract.py'
CONFIG = json.loads((ROOT / 'prime-compose-contract.fixture.json').read_text())
IMAGE = 'ghcr.io/arcanada-one/vocatlas-factory@sha256:' + 'a' * 64


class ContractTests(unittest.TestCase):
    def run_check(self, config=None, raw=None, image=IMAGE, port='18993'):
        return subprocess.run([sys.executable, '-I', str(HELPER), '--expected-image', image,
                               '--expected-port', port], input=raw if raw is not None else json.dumps(config),
                              capture_output=True, text=True, timeout=3)

    def test_independent_rendered_positive(self):
        result = self.run_check(CONFIG)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['runtime_authorized'], False)

    def test_current_factory_split_tmpfs_refused(self):
        original=json.loads((ROOT / "prime-compose-contract.split-tmpfs.fixture.json").read_text())
        self.assertEqual(self.run_check(original).returncode,1)

    def test_actual_negative_changes(self):
        changes = [
            ('public_bind', lambda s: s['ports'][0].update(host_ip='0.0.0.0')),
            ('wrong_port', lambda s: s['ports'][0].update(published='18994')),
            ('floating_image', lambda s: s.update(image='ghcr.io/arcanada-one/vocatlas-factory:latest')),
            ('wrong_digest', lambda s: s.update(image=IMAGE[:-1]+'b')),
            ('credential', lambda s: s['environment'].update(PRIME_TOKEN='fixture-private-never-output')),
            ('host_mount', lambda s: s.update(volumes=[{'type':'bind','source':'/','target':'/host'}])),
            ('privileged', lambda s: s.update(privileged=True)),
            ('host_network', lambda s: s.update(network_mode='host')),
            ('root', lambda s: s.update(user='0:0')),
            ('writable', lambda s: s.update(read_only=False)),
            ('caps', lambda s: s.update(cap_add=['SYS_ADMIN'])),
            ('no_nnp', lambda s: s.update(security_opt=[])),
            ('entrypoint', lambda s: s.update(entrypoint=['sh','-c','unsafe'])),
            ('healthcheck', lambda s: s['healthcheck'].update(test=['CMD','true'])),
            ('limit', lambda s: s.update(pids_limit=0)),
            ('authority', lambda s: s['labels'].update({'org.arcanada.authority':'production'})),
            ('bool_as_int', lambda s: s.update(init=1)),
        ]
        for name, change in changes:
            with self.subTest(name=name):
                config = copy.deepcopy(CONFIG)
                change(config['services']['health'])
                result = self.run_check(config)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn('fixture-private', result.stdout+result.stderr)
        for name in ['other_service','external_network','global_volume']:
            with self.subTest(name=name):
                config=copy.deepcopy(CONFIG)
                if name=='other_service': config['services']['foreign']={}
                elif name=='external_network': config['networks']['health']['external']=True
                else: config['volumes']={'foreign':{}}
                self.assertEqual(self.run_check(config).returncode,1)

    def test_transport_and_argument_refusals(self):
        for raw in ['{', '{"secret":"fixture-private-never-output"}',
                    '{"name":"prime","name":"prime"}', ' ' * 65537, '{"cpus":NaN}']:
            with self.subTest(raw_kind=raw[:10]):
                r=self.run_check(raw=raw)
                self.assertEqual(r.returncode,1)
                self.assertNotIn('fixture-private',r.stdout+r.stderr)
        for image in ['x:latest','ghcr.io/foreign/private@sha256:'+'a'*64]:
            self.assertEqual(self.run_check(CONFIG,image=image).returncode,1)
        for port in ['80','65536']:
            self.assertEqual(self.run_check(CONFIG,port=port).returncode,1)


if __name__=='__main__': unittest.main()
