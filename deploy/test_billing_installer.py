"""Execute the copied root installer in an unprivileged owned filesystem.
Only root metadata/owner assignment are simulated; file replacement is real.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        for name in ['billing-transaction.py', 'arcanada-compose-broker.sh', 'arcanada-compose-broker.sudoers']:
            (self.source / name).write_bytes((HERE / name).read_bytes())
        for name in ['usr/local/lib', 'usr/local/sbin', 'etc/sudoers.d']:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.target = self.root / 'usr/local/sbin/arcanada-compose-broker'
        self.target.write_text('old reviewed broker')
        self.target.chmod(0o755)
        source = (HERE / 'install-arcanada-compose-broker.sh').read_text()
        source = source.replace('/usr', str(self.root / 'usr')).replace('/etc', str(self.root / 'etc')).replace('/var', str(self.root / 'var'))
        self.script = self.source / 'install.sh'
        self.script.write_text(source)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        fixtures = {
            'id': '#!/bin/sh\necho 0\n',
            'stat': '''#!/bin/sh
case "$2" in
%U) echo root;;
%U:%G:%a) mode=$(/usr/bin/stat -c '%a' "$3"); echo "root:root:$mode";;
*) exec /usr/bin/stat "$@";;
esac
''',
            'install': '''#!/usr/bin/python3
import subprocess,sys
args=sys.argv[1:];out=[]
while args:
 item=args.pop(0)
 if item in ('-o','-g'):args.pop(0)
 else:out.append(item)
sys.exit(subprocess.call(['/usr/bin/install']+out))
''',
            'visudo': '#!/bin/sh\ntest ! -f "$FIXTURE_ROOT/refuse-visudo"\n',
        }
        for name, code in fixtures.items():
            p = self.bin / name
            p.write_text(code)
            p.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + ':/usr/bin:/bin', FIXTURE_ROOT=str(self.root))
        self.sha = hashlib.sha256((self.source / 'arcanada-compose-broker.sh').read_bytes()).hexdigest()

    def invoke(self, sha=None):
        return subprocess.run(['/bin/bash', str(self.script), sha or self.sha], env=self.env,
                              capture_output=True, text=True, timeout=10)

    def test_publish_broker_last_with_pinned_private_helper(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.target.read_bytes(), (self.source / 'arcanada-compose-broker.sh').read_bytes())
        digest = hashlib.sha256((self.source / 'billing-transaction.py').read_bytes()).hexdigest()
        helper = self.root / 'usr/local/lib/arcanada-compose-broker' / (digest + '.py')
        self.assertEqual(helper.read_bytes(), (self.source / 'billing-transaction.py').read_bytes())
        self.assertEqual(helper.stat().st_mode & 0o777, 0o600)

    def test_explicit_root_restore_reinstalls_exact_retained_broker(self):
        old_sha = hashlib.sha256(self.target.read_bytes()).hexdigest()
        self.assertEqual(self.invoke().returncode, 0)
        result = subprocess.run(['/bin/bash', str(self.script), '--restore', old_sha],
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.target.read_text(), 'old reviewed broker')

    def test_refused_sudoers_retains_exact_old_broker(self):
        (self.root / 'refuse-visudo').touch()
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(self.target.read_text(), 'old reviewed broker')

    def test_wrong_broker_or_helper_source_refuses_before_publish(self):
        self.assertNotEqual(self.invoke('0' * 64).returncode, 0)
        (self.source / 'billing-transaction.py').write_text('changed generation')
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(self.target.read_text(), 'old reviewed broker')

    def test_changed_sudoers_never_expands_installed_authority(self):
        (self.source / 'arcanada-compose-broker.sudoers').write_text('ALL ALL=(ALL) NOPASSWD: ALL')
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(self.target.read_text(), 'old reviewed broker')
        self.assertFalse((self.root / 'etc/sudoers.d/arcanada-compose-broker').exists())

    def test_symlink_or_writable_helper_root_refuses(self):
        helper_root = self.root / 'usr/local/lib/arcanada-compose-broker'
        helper_root.symlink_to(self.root / 'source')
        self.assertNotEqual(self.invoke().returncode, 0)
        helper_root.unlink()
        helper_root.mkdir(mode=0o777)
        helper_root.chmod(0o777)
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(self.target.read_text(), 'old reviewed broker')

    def test_existing_helper_generation_never_overwritten(self):
        helper_root = self.root / 'usr/local/lib/arcanada-compose-broker'
        helper_root.mkdir(mode=0o700)
        digest = hashlib.sha256((self.source / 'billing-transaction.py').read_bytes()).hexdigest()
        helper = helper_root / (digest + '.py')
        helper.write_text('corrupted existing generation')
        helper.chmod(0o600)
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(helper.read_text(), 'corrupted existing generation')
        self.assertEqual(self.target.read_text(), 'old reviewed broker')

if __name__ == '__main__':
    unittest.main()
