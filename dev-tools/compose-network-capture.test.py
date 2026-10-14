"""Offline bounded stderr custody controls; no Docker daemon or private input."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'deploy/compose-network.test.sh'


class CaptureControls(unittest.TestCase):
    def run_case(self, valid):
        with tempfile.TemporaryDirectory() as directory:
            owned = Path(directory)
            binary = owned / 'bin'
            binary.mkdir()
            config = {
                'services': {'model-connector': {
                    'networks': {
                        'assistant-native': {'aliases': ['connector.arcanada.one']},
                        'default': {}, 'transcribator-api': {},
                    },
                    'ports': [{'host_ip': '127.0.0.1', 'target': 3900,
                               'published': '3900', 'protocol': 'tcp'}],
                }},
                'networks': {'assistant-native': {
                    'name': 'arcanada-assistant_default' if valid else 'wrong-network',
                    'external': True,
                }},
            }
            stub = binary / 'docker'
            stub.write_text('#!' + sys.executable + '\n'
                            'import sys\n'
                            'print(' + repr(json.dumps(config)) + ')\n'
                            'sys.stderr.write("SYNTHETIC_PRIVATE_STDERR_MARKER")\n')
            stub.chmod(0o700)
            script = owned / 'network.sh'
            script.write_bytes(SOURCE.read_bytes())
            (owned / 'docker-compose.yml').write_text('services: {}\n')
            result = subprocess.run(
                ['bash', str(script)], cwd=owned,
                env={'PATH': str(binary) + ':' + os.defpath,
                     'HOME': str(owned), 'TMPDIR': str(owned)},
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0 if valid else 1,
                             result.stdout + result.stderr)
            self.assertNotIn('SYNTHETIC_PRIVATE_STDERR_MARKER',
                             result.stdout + result.stderr)
            self.assertEqual(list(owned.glob('mc-compose-stderr-*.log')), [])
            if not valid:
                line = next(line for line in result.stdout.splitlines()
                            if line.startswith('COMPOSE_FAILURE_RECEIVING='))
                diagnostic = json.loads(line.split('=', 1)[1])
                self.assertEqual(diagnostic['phase'], 'network_identity')
                self.assertEqual(diagnostic['failure_code'], 'semantic_assertion')
                self.assertEqual(len(diagnostic['stderr_sha256']), 64)

    def test_success_removes_private_stderr_capture(self):
        self.run_case(True)

    def test_semantic_failure_removes_capture_and_keeps_bounded_diagnostic(self):
        self.run_case(False)


if __name__ == '__main__':
    unittest.main()
