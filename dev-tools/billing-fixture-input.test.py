"""Source-only receiver controls; no CI acquisition, private download, or Journal."""
from pathlib import Path
import importlib.util
import hashlib
import json
import os
import errno
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch, Mock

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

    def test_closed_descriptor_does_not_stop_remaining_owned_drain(self):
        custody = subject.SourceCustody(self.root, self.manifest)
        fds = [fd for _, fd, _ in custody.entries]
        os.close(fds[-1])
        with self.assertRaises(subject.CleanupRefused) as error:
            custody.release()
        self.assertEqual(error.exception.cleanup_facts,
                         [{'status': 'unknown', 'reason': 'descriptor_missing'}])
        for fd in fds:
            with self.assertRaises(OSError): os.fstat(fd)
        custody.release()  # closed custody cannot retry lost descriptor numbers

    def test_reused_descriptor_is_not_closed(self):
        custody = subject.SourceCustody(self.root, self.manifest)
        fd = custody.entries[-1][1]
        foreign = os.open('/dev/null', os.O_RDONLY)
        try:
            os.dup2(foreign, fd)
            with self.assertRaises(subject.CleanupRefused) as error:
                custody.release()
            self.assertEqual(error.exception.cleanup_facts,
                             [{'status': 'unknown', 'reason': 'descriptor_identity_changed'}])
            os.fstat(fd); custody.release(); os.fstat(fd)
        finally:
            os.close(fd); os.close(foreign)

    def test_close_error_after_release_is_not_retried_and_other_fds_drain(self):
        custody = subject.SourceCustody(self.root, self.manifest)
        fds = [fd for _, fd, _ in custody.entries]
        real = os.close
        calls = []
        def interrupted(fd):
            calls.append(fd); real(fd)
            if fd == fds[-1]: raise OSError(errno.EINTR, 'private cleanup excerpt')
        with patch.object(subject.os, 'close', side_effect=interrupted), \
             self.assertRaises(subject.CleanupRefused) as error:
            custody.release()
        self.assertEqual(calls, list(reversed(fds)))
        self.assertNotIn('private', str(error.exception))
        for fd in fds:
            with self.assertRaises(OSError): os.fstat(fd)
        custody.release()

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

    def test_partial_acquire_and_cleanup_failure_keep_both_facts(self):
        real = os.open
        opened = []
        def failing(path, flags, *args, **kwargs):
            if path == self.source:
                os.close(opened[0])
                raise OSError('private acquisition excerpt')
            fd = real(path, flags, *args, **kwargs); opened.append(fd); return fd
        with patch.object(subject.os, 'open', side_effect=failing), \
             self.assertRaises(subject.CleanupRefused) as error:
            subject.SourceCustody(self.root, self.manifest)
        self.assertEqual(error.exception.acquisition_failure['class'], 'OSError')
        self.assertEqual(error.exception.cleanup_facts[0]['reason'], 'descriptor_missing')
        self.assertNotIn('private', str(error.exception))
        for fd in opened:
            with self.assertRaises(OSError): os.fstat(fd)

    def descriptor_fixture(self):
        pins = {'module' + str(i) + '.py': hashlib.sha256(str(i).encode()).hexdigest()
                for i in range(15)}
        raw = json.dumps(pins).encode()
        (self.root / 'test/fixtures/billing-3a-module-pins.json').write_bytes(raw)
        return pins, hashlib.sha256(raw).hexdigest()

    def test_descriptor_catalogue_receiving_is_never_path_authority(self):
        import types
        pins, digest = self.descriptor_fixture()
        upstream = types.SimpleNamespace(entries={name: (10+i, value, i+1)
            for i,(name,value) in enumerate(pins.items())}, revalidate=Mock(return_value={
            'files': 15, 'runtime_authorized': False, 'transport_registered': False,
            'filesystem_published': False}))
        with patch.object(subject, 'PINS_SHA256', digest):
            result = subject.receive_descriptor_catalogue(self.root, upstream)
        self.assertFalse(result['runtime_authorized']); self.assertFalse(result['path_lease_available'])
        self.assertNotIn('source_directory', result); self.assertNotIn('entries', result)
        self.assertEqual(upstream.revalidate.call_count, 2)
        self.assertEqual(set(upstream.entries), set(pins))

    def test_descriptor_catalogue_missing_extra_wrong_hash_and_size_refuse(self):
        import types
        pins,digest = self.descriptor_fixture()
        valid = {name: (10+i,value,i+1) for i,(name,value) in enumerate(pins.items())}
        key = next(iter(valid))
        mutations = [{}, {**valid, 'foreign.py': (90,'a'*64,1)},
                     {**valid,key:(10,'a'*64,1)}, {**valid,key:(10,pins[key],1000001)}]
        for entries in mutations:
            upstream = types.SimpleNamespace(entries=entries,revalidate=Mock(return_value={
                'files':15,'runtime_authorized':False,'transport_registered':False,
                'filesystem_published':False}))
            with self.subTest(entries=len(entries)), patch.object(subject,'PINS_SHA256',digest), \
                 self.assertRaises(subject.InputRefused):
                subject.receive_descriptor_catalogue(self.root,upstream)

    def test_descriptor_revalidation_loss_and_authority_claim_refuse(self):
        import types
        pins,digest=self.descriptor_fixture()
        expected={'files':15,'runtime_authorized':False,'transport_registered':False,
                  'filesystem_published':False}
        for answers in [[{**expected,'runtime_authorized':True}],
                        [expected,ValueError('private supplier failure')]]:
            upstream=types.SimpleNamespace(entries={name:(10+i,value,1)
                for i,(name,value) in enumerate(pins.items())},revalidate=Mock(side_effect=answers))
            with patch.object(subject,'PINS_SHA256',digest),self.assertRaises(subject.InputRefused) as error:
                subject.receive_descriptor_catalogue(self.root,upstream)
            self.assertNotIn('private',str(error.exception))

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
