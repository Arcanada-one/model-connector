"""Bounded caller-owned PATH negatives; no installer, daemon or service effects."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent


class CallerEnvironment(unittest.TestCase):
    def test_installer_refuses_forged_path_identity_before_any_install(self):
        if os.getuid() == 0:
            self.skipTest('receiving negative requires the actual unprivileged UID')
        with tempfile.TemporaryDirectory(prefix='broker-owned-path-') as directory:
            root = Path(directory)
            marker = root / 'identity-called'
            fake = root / 'id'
            # The forged utility ignores the ordinary -u argument and reports root.
            fake.write_text(f'#!/bin/sh\nprintf called > "{marker}"\nprintf "0\\n"\n', encoding='utf-8')
            fake.chmod(0o755)
            result = subprocess.run(
                ['/bin/bash', str(HERE / 'install-arcanada-compose-broker.sh')],
                env={'PATH': str(root) + ':/usr/bin:/bin', 'HOME': str(root), 'LC_ALL': 'C'},
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn('must run as root', result.stderr)
            self.assertFalse(marker.exists(), 'caller-owned identity utility executed')

    def test_broker_keeps_external_utility_path_readonly(self):
        raw = (HERE / 'arcanada-compose-broker.sh').read_text(encoding='utf-8')
        # Execute only the exact source prefix preceding the service tables.
        prefix = raw.split('declare -rA REPOS=(', 1)[0]
        result = subprocess.run(
            ['/bin/bash', '-c', prefix + '\nprintf "%s\\n" "$PATH"\nPATH=/caller-owned\n'],
            env={'PATH': '/caller-owned', 'LC_ALL': 'C'},
            capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), '/usr/sbin:/usr/bin:/sbin:/bin')
        self.assertIn('readonly variable', result.stderr)


if __name__ == '__main__':
    unittest.main()
