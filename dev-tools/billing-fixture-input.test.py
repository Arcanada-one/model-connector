"""Source-only receiver controls; no CI acquisition, private download, or Journal."""
from pathlib import Path
import importlib.util
import hashlib
import json
import os
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('billing_input', ROOT / 'scripts/billing_fixture_input.py')
subject = importlib.util.module_from_spec(spec); spec.loader.exec_module(subject)


class Controls(unittest.TestCase):
    def setUp(self):
        # HOME-backed private fixtures avoid the world-writable /tmp ancestor.
        self.temp = tempfile.TemporaryDirectory(dir=Path.home())
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'root'; self.root.mkdir(mode=0o700)
        (self.root / 'test/fixtures').mkdir(parents=True, mode=0o700)
        self.source = self.base / 'source'; self.source.mkdir(mode=0o700)
        (self.source / 'journal.py').write_bytes(b'synthetic receiver bytes')
        (self.source / 'journal.py').chmod(0o600)
        self.pins = {'journal.py': hashlib.sha256(b'synthetic receiver bytes').hexdigest()}
        raw = json.dumps(self.pins).encode()
        (self.root / 'test/fixtures/billing-3a-module-pins.json').write_bytes(raw)
        self.pin = patch.object(subject, 'PINS_SHA256', hashlib.sha256(raw).hexdigest())
        self.pin.start(); self.addCleanup(self.pin.stop)
        self.manifest = self.base / 'input.json'
        self.value = {'schema': 'BillingFixtureProtectedInput/v1',
            'repository': subject.REPOSITORY, 'revision': subject.REVISION,
            'scope': 'offline_fixture_only', 'source_directory': str(self.source),
            'modules': self.pins}
        self.write()

    def write(self):
        self.manifest.write_text(json.dumps(self.value)); self.manifest.chmod(0o600)

    def test_retained_custody_releases_own_fds_without_deleting_producer(self):
        custody = subject.SourceCustody(self.root, self.manifest)
        fds = [fd for _, fd, _ in custody.entries]
        custody.revalidate()
        custody.release(); custody.release()
        for fd in fds:
            with self.assertRaises(OSError): os.fstat(fd)
        self.assertTrue(self.manifest.is_file())
        self.assertTrue((self.source / 'journal.py').is_file())
        with self.assertRaises(subject.InputRefused): custody.revalidate()

    def test_retained_custody_rejects_same_bytes_replacement(self):
        custody = subject.SourceCustody(self.root, self.manifest)
        self.addCleanup(custody.release)
        file = self.source / 'journal.py'
        file.unlink(); file.write_bytes(b'synthetic receiver bytes'); file.chmod(0o600)
        with self.assertRaises(subject.InputRefused): custody.revalidate()

    def test_partial_acquisition_failure_closes_already_opened_fds(self):
        real = os.open
        opened = []
        def failing(path, flags, *args, **kwargs):
            if path == self.source: raise OSError('synthetic acquisition failure')
            fd = real(path, flags, *args, **kwargs); opened.append(fd); return fd
        with patch.object(subject.os, 'open', side_effect=failing):
            with self.assertRaises(subject.InputRefused): subject.SourceCustody(self.root, self.manifest)
        self.assertTrue(opened)
        for fd in opened:
            with self.assertRaises(OSError): os.fstat(fd)

    def test_exact_source_binds_only_explicit_clean_copy(self):
        clean = {'HOME': '/private', 'PATH': '/usr/bin:/bin'}
        with patch.dict(os.environ, {'BILLING_CUSTODIAN_SOURCE': '/foreign'}):
            result = subject.bind_clean_environment(self.root, clean, self.manifest)
        self.assertEqual(result['BILLING_CUSTODIAN_SOURCE'], str(self.source))
        self.assertNotIn('BILLING_CUSTODIAN_SOURCE', clean)

    def test_absent_and_ambient_input_refused(self):
        with self.assertRaises(subject.InputRefused):
            subject.receive(self.root, self.base / 'absent')
        with self.assertRaises(subject.InputRefused):
            subject.bind_clean_environment(self.root, {'BILLING_CUSTODIAN_SOURCE': '/foreign'}, self.manifest)

    def test_wrong_identity_or_grant_scope_refused(self):
        for key, value in [('revision', '0'*40), ('repository', 'foreign'),
                           ('scope', 'runtime_authorized'), ('modules', {})]:
            original = self.value[key]; self.value[key] = value; self.write()
            with self.assertRaises(subject.InputRefused):
                subject.receive(self.root, self.manifest)
            self.value[key] = original

    def test_source_alteration_and_foreign_member_refused(self):
        (self.source / 'journal.py').write_bytes(b'altered')
        with self.assertRaises(subject.InputRefused): subject.receive(self.root, self.manifest)
        (self.source / 'journal.py').write_bytes(b'synthetic receiver bytes')
        (self.source / 'foreign.py').write_text('foreign')
        with self.assertRaises(subject.InputRefused): subject.receive(self.root, self.manifest)

    def test_symlink_and_public_permissions_refused(self):
        file = self.source / 'journal.py'; file.unlink(); file.symlink_to(self.manifest)
        with self.assertRaises(subject.InputRefused): subject.receive(self.root, self.manifest)
        file.unlink(); file.write_bytes(b'synthetic receiver bytes'); file.chmod(0o644)
        with self.assertRaises(subject.InputRefused): subject.receive(self.root, self.manifest)
        file.chmod(0o600); self.base.chmod(0o777)
        with self.assertRaises(subject.InputRefused): subject.receive(self.root, self.manifest)

    def test_duplicate_and_oversized_manifest_refused(self):
        self.manifest.write_text('{"schema":"a","schema":"b"}')
        with self.assertRaises(subject.InputRefused): subject.receive(self.root, self.manifest)
        self.manifest.write_text(' ' * 8193)
        with self.assertRaises(subject.InputRefused): subject.receive(self.root, self.manifest)

    def test_noncanonical_and_invalid_source_locator_refused(self):
        for value in [str(self.source / '..' / 'source'), 'relative',
                      str(self.source) + '\x00private', None]:
            self.value['source_directory'] = value; self.write()
            with self.assertRaises(subject.InputRefused) as error:
                subject.receive(self.root, self.manifest)
            self.assertEqual(str(error.exception), 'protected fixture input refused')

    def test_actual_fifo_refused_without_blocking_and_owned_child_reaped(self):
        fifo = self.base / 'fifo'; os.mkfifo(fifo, 0o600)
        code = '''import importlib.util,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('receiver',sys.argv[1])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
try:m._bytes(Path(sys.argv[2]),8192)
except m.InputRefused:sys.exit(0)
sys.exit(1)
'''
        child = subprocess.Popen([sys.executable, '-B', '-c', code,
            str(ROOT / 'scripts/billing_fixture_input.py'), str(fifo)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            self.assertEqual(child.wait(timeout=1), 0)
        finally:
            if child.poll() is None: child.terminate()
            child.wait(timeout=1)
            child.stderr.close()
            fifo.unlink()
        self.assertIsNotNone(child.returncode)
        self.assertFalse(fifo.exists())

    def test_regular_leaf_swapped_to_fifo_refused_before_read(self):
        file = self.source / 'journal.py'
        native_open = os.open
        opened = []
        def swapped_open(path, flags):
            self.assertTrue(flags & os.O_NONBLOCK)
            file.unlink(); os.mkfifo(file, 0o600)
            fd = native_open(path, flags); opened.append(fd)
            return fd
        with patch.object(subject.os, 'open', side_effect=swapped_open):
            with self.assertRaises(subject.InputRefused): subject._bytes(file, 8192)
        with self.assertRaises(OSError): os.fstat(opened[0])
        file.unlink()


if __name__ == '__main__':
    unittest.main()
