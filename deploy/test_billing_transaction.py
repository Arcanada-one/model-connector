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
import threading
import time
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
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        # Model production root ancestry outside this owned disposable root.
        # CI may place it under sticky shared /tmp; Orca maps / to UID1000.
        # No production flag is added: all fixture nodes, modes, ownership,
        # symlinks, writes and inode exchanges inside the root remain real.
        actual_lstat = Path.lstat
        ancestors = set(self.root.parents)
        def lstat(path):
            st = actual_lstat(path)
            if path in ancestors:
                fields = list(st)
                fields[0] = 0o40755
                fields[4] = 0
                return os.stat_result(fields)
            return st
        ancestor = patch.object(Path, 'lstat', lstat)
        ancestor.start()
        self.addCleanup(ancestor.stop)
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

    def test_writable_owned_state_root_is_not_normalized_away(self):
        fixture = Fixture()
        self.root.chmod(0o777)
        with self.assertRaises(subject.Refusal):
            self.engine(fixture).deploy(NEW, SENTINEL)
        self.assertEqual(fixture.calls, [])

    def test_staged_symlink_or_tracked_env_refuses_before_tag_or_build(self):
        for point in ['stage-symlink', 'tracked-env']:
            fixture = Fixture(failure=point)
            with self.assertRaises(subject.Refusal):
                self.engine(fixture).deploy(NEW, SENTINEL)
            self.assertEqual(fixture.tags, {})
            self.assertEqual(fixture.live, LIVE)

    def test_interrupted_up_retains_unsettled_native_boundary_and_refuses_recovery(self):
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
        with self.assertRaises(subject.Refusal):
            engine.recover(ident)
        self.assertEqual(engine.load()['phase'], 'up-intent')
        self.assertEqual(engine.load()['native_action']['completion'], 'pending')
        self.assertEqual(fixture.live, CANDIDATE)

    def test_actual_native_timeout_preserves_unknown_type_without_child_exception_text(self):
        native = subject.Native()
        native.deadline = time.monotonic() + 0.04
        with self.assertRaises(subject.NativeOutcomeUnknown) as raised:
            native.call([sys.executable, '-c', 'import time; time.sleep(1)'])
        self.assertEqual(str(raised.exception), 'native completion is unknown')

    def test_late_build_effect_after_timeout_never_authorizes_recovery_or_new_deploy(self):
        fixture = Fixture()
        release = threading.Event()
        finished = threading.Event()
        def delayed(path, revision, action):
            if action != 'build':
                raise AssertionError('unexpected rollback or new native effect')
            def daemon():
                if release.wait(1):
                    fixture.latest = CANDIDATE
                finished.set()
            worker = threading.Thread(target=daemon)
            worker.start()
            self.addCleanup(worker.join, 2)
            self.addCleanup(release.set)
            raise subject.NativeOutcomeUnknown('native completion is unknown')
        fixture.compose = delayed
        engine = self.engine(fixture)
        with self.assertRaises(subject.Refusal):
            engine.deploy(NEW, SENTINEL)
        ident = engine.load()['id']
        self.assertEqual(engine.load()['native_action'], {'name': 'build', 'completion': 'pending'})
        for after_late_completion in (False, True):
            if after_late_completion:
                release.set()
                self.assertTrue(finished.wait(1))
                self.assertEqual(fixture.latest, CANDIDATE)
            with self.assertRaises(subject.Refusal):
                engine.check(NEW)
            with self.assertRaises(subject.Refusal):
                engine.deploy(NEW, SENTINEL)
            with self.assertRaises(subject.Refusal):
                engine.recover(ident)
            self.assertEqual(engine.load()['phase'], 'build-intent')
            self.assertEqual((self.current / 'revision').read_text(), OLD)
            self.assertNotIn('latest', fixture.tags)

    def test_keyboard_interrupt_during_native_up_retains_pending_boundary(self):
        fixture = Fixture()
        original = fixture.compose
        def interrupted(path, revision, action):
            original(path, revision, action)
            if action == 'up':
                raise KeyboardInterrupt
        fixture.compose = interrupted
        engine = self.engine(fixture)
        with self.assertRaises(subject.Refusal):
            engine.deploy(NEW, SENTINEL)
        state = engine.load()
        self.assertEqual(state['native_action'], {'name': 'up', 'completion': 'pending'})
        self.assertEqual(state['phase'], 'up-intent')
        with self.assertRaises(subject.Refusal):
            engine.recover(state['id'])
        self.assertEqual(fixture.live, CANDIDATE)

    def test_native_completion_write_failure_retains_pending_recovery_fence(self):
        fixture = Fixture()
        def writer(path, data):
            if data.get('native_action', {}).get('completion') != 'pending':
                if 'native_action' in data:
                    raise OSError('fixture cannot persist native completion')
            subject.atomic_state(path, data)
        engine = self.engine(fixture, writer=writer)
        with self.assertRaises(subject.Refusal):
            engine.deploy(NEW, SENTINEL)
        state = engine.load()
        self.assertEqual(state['native_action']['completion'], 'pending')
        with self.assertRaises(subject.Refusal):
            self.engine(fixture).recover(state['id'])

    def test_one_shot_completion_write_failure_never_replaces_pending_with_rollback(self):
        for completion in ('returned', 'returned-refusal'):
            with self.subTest(completion=completion):
                fixture = Fixture(failure='build' if completion == 'returned-refusal' else None)
                failed = []
                def writer(path, data):
                    action = data.get('native_action', {})
                    if not failed and action == {'name': 'build', 'completion': completion}:
                        failed.append(True)
                        raise OSError('one-shot completion write failed')
                    subject.atomic_state(path, data)
                engine = self.engine(fixture, writer=writer)
                with self.assertRaises(subject.Refusal):
                    engine.deploy(NEW, SENTINEL)
                self.assertEqual(failed, [True])
                state = engine.load()
                self.assertEqual(state['phase'], 'build-intent')
                self.assertEqual(state['native_action'], {'name': 'build', 'completion': 'pending'})
                self.assertTrue(engine.pending(engine.state))
                self.assertEqual(fixture.latest, CANDIDATE)
                self.assertNotIn('latest', fixture.tags)
                fresh = self.engine(fixture)
                with self.assertRaises(subject.Refusal):
                    fresh.recover(state['id'])
                with self.assertRaises(subject.Refusal):
                    fresh.check(NEW)
                with self.assertRaises(subject.Refusal):
                    fresh.deploy(NEW, SENTINEL)
                # Only this fixture's protected journal is reset between cases.
                (engine.private / 'active.json').unlink()

    def test_native_health_propagates_unknown_without_retry_or_sleep(self):
        for point in ('container', 'docker-exec'):
            with self.subTest(point=point):
                native = subject.Native()
                calls = []
                def call(argv, **kwargs):
                    calls.append(argv)
                    if argv[1:3] == ['image', 'inspect']:
                        return NEW
                    if argv[1] == 'inspect':
                        if point == 'container':
                            raise subject.NativeOutcomeUnknown('native completion is unknown')
                        return '|'.join([CANDIDATE, 'true', 'healthy', 'billing-arcana',
                                         'billing', str(subject.STATE / 'billing-arcana/compose.deploy.yml')])
                    raise subject.NativeOutcomeUnknown('native completion is unknown')
                with patch.object(native, 'call', call), patch.object(subject.time, 'sleep') as sleep:
                    with self.assertRaises(subject.NativeOutcomeUnknown):
                        native.health(CANDIDATE, NEW)
                    sleep.assert_not_called()
                self.assertEqual(len(calls), 2 if point == 'container' else 3)

    def test_unknown_native_health_keeps_transaction_pending_without_commit_or_rollback(self):
        fixture = Fixture()
        def health(image, revision):
            native = subject.Native()
            with patch.object(native, 'verify_image'), patch.object(
                    native, 'container', side_effect=subject.NativeOutcomeUnknown('native completion is unknown')):
                native.health(image, revision)
        fixture.health = health
        engine = self.engine(fixture)
        with self.assertRaises(subject.Refusal):
            engine.deploy(NEW, SENTINEL)
        state = engine.load()
        self.assertEqual(state['phase'], 'up-intent')
        self.assertEqual(state['native_action'], {'name': 'health', 'completion': 'pending'})
        self.assertEqual(fixture.live, CANDIDATE)
        self.assertNotIn(NEW, fixture.tags)
        self.assertNotIn('latest', fixture.tags)
        with self.assertRaises(subject.Refusal):
            self.engine(fixture).recover(state['id'])

    def test_recovery_timeout_stays_nonterminal_and_blocks_second_owner(self):
        fixture = Fixture()
        engine = self.engine(fixture)
        ident = engine.deploy(NEW, SENTINEL)
        def uncertain_tag(image, tag):
            raise subject.NativeOutcomeUnknown('native completion is unknown')
        fixture.tag = uncertain_tag
        with self.assertRaises(subject.NativeOutcomeUnknown):
            engine.recover(ident)
        state = engine.load()
        self.assertEqual(state['phase'], 'recovery-intent')
        self.assertEqual(state['native_action'], {'name': 'restore-image', 'completion': 'pending'})
        with self.assertRaises(subject.Refusal):
            self.engine(fixture).check(NEW)
        with self.assertRaises(subject.Refusal):
            self.engine(fixture).recover(ident)
        self.assertEqual(fixture.live, CANDIDATE)

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
