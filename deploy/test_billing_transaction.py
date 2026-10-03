"""Real private directories/rename/fsync; no daemon, GitHub or payment calls."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('billing_transaction', Path(__file__).with_name('billing-transaction.py'))
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)
OLD, NEW = 'a' * 40, 'b' * 40
LIVE, CANDIDATE = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64
SENTINEL = 'fixture-secret-must-not-escape'

class Fixture:
    def __init__(self, failure=None, latest=LIVE):
        self.failure, self.latest = failure, latest
        self.calls = []
        self.live = LIVE
        self.tags = {}

    def fail(self, action):
        if self.failure == action:
            self.failure = None
            raise subject.Refusal('native fixture refused')

    def recovery_budget(self):
        pass

    def head(self, path):
        return (path / 'revision').read_text()

    def baseline(self, revision):
        self.fail('baseline')
        if revision != OLD:
            raise subject.Refusal('wrong baseline')
        return self.live

    def image(self, ref, optional=False):
        self.fail('image')
        return self.latest

    def tag(self, image, tag):
        self.fail('tag')
        self.tags[tag] = image
        if tag == 'latest':
            self.latest = image

    def verify_image(self, image, revision):
        self.fail('verify-image')
        if (image, revision) not in [(LIVE, OLD), (CANDIDATE, NEW)]:
            raise subject.Refusal('wrong image')

    def health(self, image, revision):
        self.fail('health')
        if self.live != image:
            raise subject.Refusal('wrong installed image')

    def stage(self, path, revision, credential):
        self.calls.append(('stage', revision))
        self.fail('stage')  # Expired/missing scope refuses native Git fetch.
        path.mkdir(mode=0o700)
        (path / 'revision').write_text(revision)
        (path / 'compose.deploy.yml').write_text('new compose')
        if self.failure == 'stage-symlink':
            (path / 'compose.deploy.yml').unlink()
            (path / 'compose.deploy.yml').symlink_to('/etc/passwd')
        if self.failure == 'tracked-env':
            (path / '.env').write_text('tracked env')

    def compose(self, path, revision, action):
        self.calls.append((action, revision, (path / 'compose.deploy.yml').read_text()))
        if action == 'build':
            self.latest = CANDIDATE  # Partial build failure can change latest.
        elif action == 'up':
            self.live = self.latest  # Partial up failure can replace the service.
        self.fail(action)

class Tests(unittest.TestCase):
    def setUp(self):
        # This unprivileged Orca test namespace maps filesystem / to UID1000.
        # Model only that ancestor as production root; all fixture ownership,
        # modes, symlinks, inode exchange and writes remain real. No runtime flag.
        actual_lstat = Path.lstat
        def lstat(path):
            st = actual_lstat(path)
            if path == Path('/'):
                fields = list(st)
                fields[4] = 0
                return os.stat_result(fields)
            return st
        ancestor = patch.object(Path, 'lstat', lstat)
        ancestor.start()
        self.addCleanup(ancestor.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.current = self.root / 'billing-arcana'
        self.current.mkdir(mode=0o700)
        (self.current / 'revision').write_text(OLD)
        (self.current / 'compose.deploy.yml').write_text('old compose')
        (self.current / '.env').write_text(SENTINEL + '-old')
        (self.current / '.env').chmod(0o600)
        self.env = self.root / 'source.env'
        self.env.write_text(SENTINEL + '-new')
        self.env.chmod(0o600)

    def engine(self, fixture, **kwargs):
        return subject.Transaction(self.root, self.env, fixture, os.getuid(), **kwargs)

    def assert_old(self, fixture):
        self.assertEqual((self.current / 'revision').read_text(), OLD)
        self.assertEqual((self.current / 'compose.deploy.yml').read_text(), 'old compose')
        self.assertEqual((self.current / '.env').read_text(), SENTINEL + '-old')
        self.assertEqual(fixture.latest, LIVE)
        self.assertEqual(fixture.live, LIVE)

    def test_success_keeps_protected_exact_baseline_and_journal(self):
        fixture = Fixture()
        engine = self.engine(fixture)
        ident = engine.deploy(NEW, SENTINEL)
        baseline = engine.private / ident / 'checkout'
        self.assertEqual((self.current / 'revision').read_text(), NEW)
        self.assertEqual((self.current / '.env').read_text(), SENTINEL + '-new')
        self.assertEqual((baseline / '.env').read_text(), SENTINEL + '-old')
        self.assertEqual(engine.load()['phase'], 'committed')
        self.assertEqual((engine.private / 'active.json').stat().st_mode & 0o777, 0o600)
        self.assertNotIn(SENTINEL, (engine.private / 'active.json').read_text())
        engine.recover(ident)
        self.assert_old(fixture)

    def test_failed_build_up_health_or_release_tag_restores_every_baseline(self):
        for point in ['build', 'up', 'health', 'verify-image', 'tag']:
            with self.subTest(point=point):
                fixture = Fixture(failure=point)
                engine = self.engine(fixture)
                with self.assertRaises(subject.Refusal):
                    engine.deploy(NEW, SENTINEL)
                self.assert_old(fixture)
                self.assertEqual(engine.load()['phase'], 'rolled-back')

    def test_failed_state_write_after_exchange_restores_old_checkout_env_and_image(self):
        def writer(path, data):
            if data['phase'] == 'up-intent':
                raise OSError('fixture write failed')
            subject.atomic_state(path, data)
        fixture = Fixture()
        engine = self.engine(fixture, writer=writer)
        with self.assertRaises(subject.Refusal):
            engine.deploy(NEW, SENTINEL)
        self.assert_old(fixture)

    def test_initial_state_write_failure_has_no_image_or_checkout_effect(self):
        fixture = Fixture()
        def writer(path, data):
            raise OSError('fixture disk failure')
        with self.assertRaises(OSError):
            self.engine(fixture, writer=writer).deploy(NEW, SENTINEL)
        self.assert_old(fixture)
        self.assertEqual(fixture.tags, {})

    def test_exchange_failure_before_or_after_rename_rolls_back_by_inode(self):
        for after in [False, True]:
            def swap(left, right):
                if after and (left / 'revision').read_text() == OLD:
                    subject.exchange(left, right)
                    raise subject.Refusal('fixture fsync failed after exchange')
                if not after:
                    raise subject.Refusal('fixture unsupported exchange')
                subject.exchange(left, right)
            fixture = Fixture()
            with self.assertRaises(subject.Refusal):
                self.engine(fixture, swap=swap).deploy(NEW, SENTINEL)
            self.assert_old(fixture)

    def test_missing_latest_is_bootstrapped_only_from_healthy_actual_image(self):
        fixture = Fixture(latest=None)
        engine = self.engine(fixture)
        ident = engine.deploy(NEW, SENTINEL)
        self.assertEqual(fixture.tags['previous'], LIVE)
        engine.recover(ident)
        self.assert_old(fixture)

    def test_stale_latest_missing_baseline_or_expired_fetch_has_no_live_effect(self):
        for fixture in [Fixture(latest=CANDIDATE), Fixture(failure='baseline'), Fixture(failure='stage'), Fixture(failure='image')]:
            with self.assertRaises(subject.Refusal):
                self.engine(fixture).deploy(NEW, SENTINEL)
            self.assertEqual(fixture.live, LIVE)
            self.assertEqual(fixture.tags, {})
            self.assertEqual((self.current / 'revision').read_text(), OLD)

    def test_unsafe_environment_ownership_or_symlink_refuses_before_native(self):
        for case in ['mode', 'symlink', 'owner']:
            fixture = Fixture()
            if case == 'mode':
                self.env.chmod(0o666)
            elif case == 'symlink':
                self.env.unlink()
                self.env.symlink_to(self.current / '.env')
            engine = self.engine(fixture)
            if case == 'owner':
                engine.uid = os.getuid() + 1
            with self.assertRaises(subject.Refusal):
                engine.deploy(NEW, SENTINEL)
            self.assertEqual(fixture.calls, [])
            if self.env.is_symlink():
                self.env.unlink()
                self.env.write_text(SENTINEL)
            self.env.chmod(0o600)

    def test_staged_symlink_or_tracked_env_refuses_before_tag_or_build(self):
        for point in ['stage-symlink', 'tracked-env']:
            fixture = Fixture(failure=point)
            with self.assertRaises(subject.Refusal):
                self.engine(fixture).deploy(NEW, SENTINEL)
            self.assertEqual(fixture.tags, {})
            self.assertEqual(fixture.live, LIVE)

    def test_interrupted_up_has_owned_explicit_recovery_and_blocks_new_deploy(self):
        fixture = Fixture()
        original = fixture.compose
        def interrupted(path, revision, action):
            original(path, revision, action)
            if action == 'up' and revision == NEW:
                raise SystemExit(137)
        fixture.compose = interrupted
        engine = self.engine(fixture)
        with self.assertRaises(SystemExit):
            engine.deploy(NEW, SENTINEL)
        ident = engine.load()['id']
        with self.assertRaises(subject.Refusal):
            engine.deploy(NEW, SENTINEL)
        with self.assertRaises(subject.Refusal):
            engine.recover('0' * 32)
        engine.recover(ident)
        self.assert_old(fixture)

    def test_changed_checkout_inode_refuses_recovery_instead_of_guessing(self):
        fixture = Fixture()
        engine = self.engine(fixture)
        ident = engine.deploy(NEW, SENTINEL)
        self.current.rename(self.root / 'foreign-preserved')
        self.current.mkdir(mode=0o700)
        with self.assertRaises(subject.Refusal):
            engine.recover(ident)
        self.assertTrue((self.root / 'foreign-preserved').exists())
        self.assertEqual(fixture.live, CANDIDATE)

    def test_lock_fences_second_owner_and_missing_credential_has_no_state_effect(self):
        fixture = Fixture()
        engine = self.engine(fixture)
        with self.assertRaises(subject.Refusal):
            engine.deploy(NEW, '')
        self.assertFalse(engine.private.exists())
        fd = engine.lock()
        try:
            with self.assertRaises(subject.Refusal):
                self.engine(fixture).deploy(NEW, SENTINEL)
        finally:
            os.close(fd)
        self.assertEqual(fixture.calls, [])

    def test_baseline_check_refuses_before_fetch_and_never_mutates_images(self):
        fixture = Fixture()
        self.engine(fixture).check(NEW)
        self.assertEqual(fixture.calls, [])
        self.assertEqual(fixture.tags, {})
        for point in ['baseline', 'image']:
            with self.assertRaises(subject.Refusal):
                self.engine(Fixture(failure=point)).check(NEW)

    def test_corrupt_journal_and_unsafe_state_are_refused_before_recovery(self):
        fixture = Fixture()
        engine = self.engine(fixture)
        ident = engine.deploy(NEW, SENTINEL)
        path = engine.private / 'active.json'
        data = engine.load()
        data['old_sha'] = 'not-a-sha'
        subject.atomic_state(path, data)
        with self.assertRaises(subject.Refusal):
            engine.recover(ident)
        self.assertEqual(fixture.live, CANDIDATE)
        path.chmod(0o644)
        with self.assertRaises(subject.Refusal):
            engine.load()

    def test_container_name_does_not_override_project_service_or_source_custody(self):
        native = subject.Native()
        valid = [LIVE, 'true', 'healthy', 'billing-arcana', 'billing', str(subject.STATE / 'billing-arcana/compose.deploy.yml')]
        with patch.object(native, 'call', return_value='|'.join(valid)):
            self.assertEqual(native.container()[0], LIVE)
        for field, value in [(3, 'foreign'), (4, 'other'), (5, '/tmp/foreign.yml')]:
            data = list(valid)
            data[field] = value
            with patch.object(native, 'call', return_value='|'.join(data)):
                with self.assertRaises(subject.Refusal):
                    native.container()

    def test_docker_listing_failure_is_not_missing_latest(self):
        native = subject.Native()
        with patch.object(native, 'call', side_effect=subject.Refusal('Docker denied')):
            with self.assertRaises(subject.Refusal):
                native.image(subject.IMAGE + ':latest', optional=True)
        with patch.object(native, 'call', return_value=''):
            self.assertIsNone(native.image(subject.IMAGE + ':latest', optional=True))

    def test_native_git_credential_only_in_protected_env_not_argv_or_docker_env(self):
        native = subject.Native()
        calls = []
        def call(argv, **kwargs):
            calls.append((argv, kwargs.get('env')))
            return ''
        with patch.object(native, 'call', call):
            native.stage(self.root / 'stage', NEW, SENTINEL)
            native.compose(self.current, NEW, 'build')
        self.assertNotIn(SENTINEL, repr([args for args, _ in calls]))
        self.assertTrue(any('GIT_CONFIG_VALUE_0' in (env or {}) for _, env in calls))
        self.assertNotIn('GIT_CONFIG_VALUE_0', calls[-1][1])
        self.assertNotIn(SENTINEL, repr(calls[-1]))

    def test_actual_process_argv_and_failure_logging_do_not_expose_sentinel(self):
        native = subject.Native()
        record = self.root / 'actual-process-argv.txt'
        child = "import pathlib,sys;pathlib.Path(sys.argv[1]).write_bytes(pathlib.Path('/proc/self/cmdline').read_bytes());print(sys.stdin.read(),file=sys.stderr);sys.exit(1)"
        argv = [sys.executable, '-c', child, str(record)]
        original = subprocess.run
        captured = []
        def run(args, **kwargs):
            captured.append(args)
            return original(args, input=SENTINEL, **kwargs)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(subject.subprocess, 'run', run), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(subject.Refusal) as failure:
                native.call(argv)
        self.assertNotIn(SENTINEL, repr(captured))
        self.assertNotIn(SENTINEL.encode(), record.read_bytes())
        self.assertNotIn(SENTINEL, stdout.getvalue() + stderr.getvalue() + str(failure.exception))

if __name__ == '__main__':
    unittest.main()
