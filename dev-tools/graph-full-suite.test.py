"""Focused orchestration controls only, never the four complete product suites."""
from pathlib import Path
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('full_suite', ROOT / 'scripts/graph_full_suite.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


class Controls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Host Git shims may require HOME. Give fixtures private home state,
        # never the caller's credential/config directory or a global repair.
        home = patch.dict(os.environ, {'HOME': str(self.root)})
        home.start()
        self.addCleanup(home.stop)
        for unit in subject.UNITS[1:]:
            (self.root / unit).mkdir(parents=True)

    def test_exact_native_cwd_contract_and_traversal(self):
        profile = json.loads((ROOT / '.arcana/verify.json').read_text())
        for unit in subject.UNITS:
            argv = profile['deployables'][unit]['full_test']
            self.assertEqual((ROOT / unit / argv[1]).resolve(), ROOT / 'scripts/graph-full-suite.sh')
            self.assertEqual(argv[-1], unit)
            self.assertNotIn('full_test_timeout_seconds', profile['deployables'][unit])
            subject.check_context(self.root, unit, self.root / unit)
        for unit, cwd in [('watcher', self.root), ('../escape', self.root),
                          ('packages/sdk-ts/../../.', self.root)]:
            with self.assertRaises(subject.Refusal):
                subject.check_context(self.root, unit, cwd)

    def test_symlinked_unit_and_dangling_dotenv_refuse(self):
        (self.root / 'watcher').rmdir()
        (self.root / 'watcher').symlink_to(self.root / 'packages/sdk-ts', target_is_directory=True)
        with self.assertRaises(subject.Refusal):
            subject.check_context(self.root, 'watcher', self.root / 'watcher')
        (self.root / '.env.integration').symlink_to(self.root / 'absent')
        with self.assertRaises(subject.Refusal):
            subject.check_context(self.root, '.', self.root)

    def test_source_symlink_escape_refuses(self):
        (self.root / 'source.py').symlink_to(Path(__file__))
        with self.assertRaises(subject.Refusal):
            subject.checked_file(self.root, 'source.py')

    def test_inventory_physical_changes_refuse(self):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        p = self.root / 'test_contract.py'
        p.write_text('original')
        subprocess.run(['git', '-C', str(self.root), 'add', 'test_contract.py'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture',
                        '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        self.assertEqual(len(subject.inventory(self.root)), 1)
        p.write_text('changed')
        with self.assertRaises(subject.Refusal):
            subject.inventory(self.root)
        p.write_text('original')
        (self.root / 'test_uncommitted.py').write_text('new')
        with self.assertRaises(subject.Refusal):
            subject.inventory(self.root)

    def test_root_union_preserves_all_types_and_external_skip_obligations(self):
        members = ['src/a.spec.ts', 'src/a.integration.spec.ts', 'test/app.e2e-spec.ts',
                   'dev-tools/contract.test.py', 'scripts/fixture.test.sh', 'deploy/test_install.py']
        rows = subject.plan('.', members)
        self.assertEqual(sorted(n for r in rows for n in r['members']), sorted(members))
        self.assertTrue(all(r['verdict'] == 'not_measured' for r in rows))
        self.assertTrue(subject.test_member('deploy/test_billing_transaction.py'))
        self.assertTrue(subject.test_member('dev-tools/rate-limit-ci-workflow.test.py'))
        self.assertFalse(subject.test_member('receipts/old/test_record.py'))

    def test_unknown_suite_cannot_drop_new_member(self):
        with self.assertRaises(subject.Refusal):
            subject.plan('packages/sdk-ts', ['packages/sdk-ts/test/a.spec.ts',
                                              'packages/sdk-ts/test/new.test.sh'])
        with self.assertRaises(subject.Refusal):
            subject.plan('watcher', ['watcher/test/a.spec.ts'])

    def document(self):
        return {'numTotalTests': 1, 'numPassedTests': 1, 'numFailedTests': 0,
                'testResults': [{'name': str(self.root / 'watcher/test/a.spec.ts'),
                                 'assertionResults': [{'status': 'passed'}]}]}

    def test_actual_vitest_count_parsing_and_skipped_preservation(self):
        doc = self.document()
        self.assertEqual(subject.vitest_counts(doc, ['watcher/test/a.spec.ts'], self.root),
                         {'passed': 1, 'failed': 0, 'skipped': 0})
        doc['testResults'][0]['assertionResults'][0]['status'] = 'pending'
        doc['numPassedTests'] = 0
        self.assertEqual(subject.vitest_counts(doc, ['watcher/test/a.spec.ts'], self.root)['skipped'], 1)

    def test_vitest_missing_duplicate_unexpected_zero_and_false_count(self):
        mutations = [lambda d: d.update(numTotalTests=2),
                     lambda d: d['testResults'].append(d['testResults'][0]),
                     lambda d: d['testResults'][0].update(assertionResults=[]),
                     lambda d: d['testResults'][0].update(name='/escaped/a.spec.ts')]
        for mutate in mutations:
            doc = self.document()
            mutate(doc)
            with self.assertRaises(subject.Refusal):
                subject.vitest_counts(doc, ['watcher/test/a.spec.ts'], self.root)
        with self.assertRaises(subject.Refusal):
            subject.vitest_counts(self.document(), ['watcher/test/missing.spec.ts'], self.root)

    def test_pytest_exact_identity_not_equal_count_substitution(self):
        collection = 'tests/test_client.py::test_one\ntests/test_client.py::test_two\n'
        xml = '<testsuites><testsuite><testcase classname="tests.test_client" name="test_one"/><testcase classname="tests.test_client" name="test_two"><skipped/></testcase></testsuite></testsuites>'
        counts = subject.pytest_counts(collection, xml,
                                      ['packages/sdk-python/tests/test_client.py'], 'packages/sdk-python')
        self.assertEqual(counts, {'passed': 1, 'failed': 0, 'skipped': 1})
        with self.assertRaises(subject.Refusal):
            subject.pytest_counts(collection, xml.replace('test_two', 'different'),
                                  ['packages/sdk-python/tests/test_client.py'], 'packages/sdk-python')

    def test_tap_complete_raw_counts_refuse_missing_and_duplicates(self):
        self.assertEqual(subject.bats_counts('1..2\nok 1 fixture\nok 2 other # skip unavailable\n'),
                         {'passed': 1, 'failed': 0, 'skipped': 1})
        for text in ['1..0\n', '1..2\nok 1 only\n', '1..2\nok 1 a\nok 1 b\n']:
            with self.assertRaises(subject.Refusal):
                subject.bats_counts(text)

    def test_environment_sentinel_never_in_child_argv_or_output(self):
        sentinel = 'fixture-secret-must-not-escape'
        with patch.dict(os.environ, {'PROVIDER_API_KEY': sentinel, 'NODE_OPTIONS': sentinel}):
            env = subject.clean_environment(self.root, self.root)
        self.assertNotIn(sentinel, json.dumps(env))
        command = [sys.executable, '-B', '-c',
                   "import os; assert 'PROVIDER_API_KEY' not in os.environ; assert 'NODE_OPTIONS' not in os.environ; print('fixture boundary passed')"]
        result = subject.execute(command, self.root, env, time.monotonic() + 5, self.root, 'boundary')
        self.assertEqual(result['exit_code'], 0)
        self.assertNotIn(sentinel, json.dumps(result))
        self.assertEqual(result['output'].strip(), 'fixture boundary passed')

    def test_owned_timeout_preserves124_and_native_exit(self):
        env = {'PATH': os.defpath}
        result = subject.execute([sys.executable, '-B', '-c', 'import time; time.sleep(10)'],
                                 self.root, env, time.monotonic() + .05, self.root, 'timeout')
        self.assertEqual(result['exit_code'], 124)
        result = subject.execute([sys.executable, '-B', '-c', 'raise SystemExit(9)'],
                                 self.root, env, time.monotonic() + 5, self.root, 'failure')
        self.assertEqual(result['exit_code'], 9)

    def test_missing_command_not_measured127(self):
        result = subject.execute(['/fixture/no-such-command'], self.root, {},
                                 time.monotonic() + 5, self.root, 'missing')
        self.assertEqual(result['exit_code'], 127)

    def test_skipped_suite_and_unrun_build_bats_not_pass(self):
        suites = subject.plan('watcher', ['watcher/test/a.spec.ts', 'watcher/test/a.bats'])
        def child(argv, cwd, env, deadline, scratch, name):
            doc = self.document()
            doc['numPassedTests'] = 0
            doc['testResults'][0]['assertionResults'][0]['status'] = 'pending'
            Path(argv[-1].split('=', 1)[1]).write_text(json.dumps(doc))
            return {'argv': argv, 'exit_code': 0, 'output': '', 'duration_s': 0}
        results = subject.run_suites(self.root, 'watcher', suites, self.root, child)
        self.assertEqual([r['verdict'] for r in results], ['not_measured'] * 3)

    def root_entrypoint_fixture(self):
        scripts = self.root / 'scripts'
        scripts.mkdir()
        for name in ['graph-full-suite.sh', 'graph_full_suite.py']:
            (scripts / name).write_bytes((ROOT / 'scripts' / name).read_bytes())
        (self.root / 'test_contract.py').write_text('import unittest\nclass Fixture(unittest.TestCase):\n def test_boundary(self): self.assertTrue(True)\nif __name__ == "__main__": unittest.main()\n')
        (self.root / 'test').mkdir()
        (self.root / 'test/app.e2e-spec.ts').write_text('throw new Error("must never execute")')
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', 'scripts', 'test_contract.py', 'test'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture',
                        '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)

    def test_actual_root_entrypoint_refuses_missing_empty_public_and_symlink_tmpdir(self):
        self.root_entrypoint_fixture()
        public = self.root / 'public'
        public.mkdir(mode=0o755)
        public.chmod(0o755)
        private = self.root / 'private'
        private.mkdir(mode=0o700)
        link = self.root / 'link'
        link.symlink_to(private, target_is_directory=True)
        for value in [None, '', str(public), str(link)]:
            env = {'PATH': os.defpath, 'HOME': str(self.root)}
            if value is not None:
                env['TMPDIR'] = value
            with self.subTest(TMPDIR=value):
                result = subprocess.run(['bash', 'scripts/graph-full-suite.sh', '.'], cwd=self.root,
                                        env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn('FULL_FALLBACK_TEST_REFUSED: invalid source/path/environment', result.stderr)
                self.assertEqual(list(self.root.rglob('execution.json')), [])

    def test_actual_root_entrypoint_dispatches_local_regression_retains_app_hold(self):
        self.root_entrypoint_fixture()
        temp = self.root / 'private'
        temp.mkdir(mode=0o700)
        result = subprocess.run(['bash', 'scripts/graph-full-suite.sh', '.'], cwd=self.root,
                                env={'PATH': os.defpath, 'TMPDIR': str(temp), 'HOME': str(self.root),
                                     'PROVIDER_API_KEY': 'fixture-secret-no-escape'}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 127, result.stderr)
        self.assertNotIn('fixture-secret-no-escape', result.stdout + result.stderr)
        paths = list(temp.glob('mc-full-*/execution.json'))
        self.assertEqual(len(paths), 1)
        report = json.loads(paths[0].read_text())
        self.assertEqual([r['verdict'] for r in report['results']], ['not_measured', 'verified'])
        self.assertEqual(report['results'][1]['executions'][0]['counts']['passed'], 1)
        self.assertEqual(report['results'][0]['held_members'], ['test/app.e2e-spec.ts'])
        self.assertEqual(report['exit_code'], 127)
        self.assertEqual(len(list(temp.glob('mc-full-*/*.log'))), 1)

    def root_dispatch_fixture(self, members):
        for member in members:
            p = self.root / member
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('fixture only')
        runner = self.root / 'node_modules/.bin/vitest'
        runner.parent.mkdir(parents=True)
        runner.write_text('fixture only')
        return subject.plan('.', members)

    def root_child(self, calls, status='passed', missing=False):
        def child(argv, cwd, env, deadline, scratch, name):
            calls.append(argv)
            self.assertNotIn('PROVIDER_API_KEY', env)
            self.assertNotIn('DATABASE_URL', env)
            self.assertNotIn('NODE_OPTIONS', env)
            if argv[0] == 'pnpm':
                output = next(a.split('=', 1)[1] for a in argv if a.startswith('--outputFile='))
                members = argv[argv.index('--outputFile=' + output) + 1:]
                document = {'numTotalTests': len(members),
                            'numPassedTests': len(members) if status == 'passed' else 0,
                            'numFailedTests': 0,
                            'testResults': [{'name': str(self.root / m),
                                             'assertionResults': [{'status': status}]} for m in members]}
                if missing:
                    document['testResults'] = []
                Path(output).write_text(json.dumps(document))
            return {'argv': argv, 'exit_code': 0, 'output': '', 'duration_s': 0}
        return child

    def test_root_dispatches_exact_local_members_and_retains_live_and_app(self):
        offline = sorted(subject.OFFLINE_INTEGRATION)[0]
        members = ['src/a.spec.ts', offline, 'src/auth/live.integration.spec.ts',
                   'test/app.e2e-spec.ts', 'scripts/control.test.sh']
        suites = self.root_dispatch_fixture(members)
        calls = []
        with patch.object(subject.shutil, 'which', return_value='/fixture/runner'), patch.dict(os.environ, {
                'PROVIDER_API_KEY': 'sentinel-secret', 'DATABASE_URL': 'sentinel-secret',
                'MC_ALLOW_LIVE': '1', 'NODE_OPTIONS': 'sentinel-secret'}):
            result = subject.run_root_suites(self.root, suites, self.root, self.root_child(calls))
        self.assertEqual(len(calls), 3)
        self.assertEqual(sorted(n for r in result for n in r['members']), sorted(members))
        held = [n for r in result for n in r.get('held_members', [])]
        self.assertEqual(set(held), {'src/auth/live.integration.spec.ts', 'test/app.e2e-spec.ts'})
        self.assertFalse(any('live.integration.spec.ts' in a or 'app.e2e-spec.ts' in a for args in calls for a in args))
        self.assertEqual([r['verdict'] for r in result], ['not_measured', 'not_measured', 'verified', 'verified'])
        self.assertEqual(subject.execution_code(result), 127)

    def test_root_missing_runner_refuses_before_spawn(self):
        suites = self.root_dispatch_fixture(['src/a.spec.ts'])
        with patch.object(subject.shutil, 'which', return_value=None):
            result = subject.run_root_suites(self.root, suites, self.root,
                lambda *args: self.fail('missing runner spawned a child'))
        self.assertEqual(result[0]['verdict'], 'not_measured')
        self.assertEqual(subject.execution_code(result), 127)

    def test_root_skipped_missing_and_zero_counts_never_verify(self):
        for status, missing in [('pending', False), ('passed', True)]:
            with self.subTest(status=status, missing=missing), tempfile.TemporaryDirectory() as directory:
                scratch = Path(directory)
                if not (self.root / 'src/a.spec.ts').exists():
                    suites = self.root_dispatch_fixture(['src/a.spec.ts'])
                calls = []
                with patch.object(subject.shutil, 'which', return_value='/fixture/runner'):
                    result = subject.run_root_suites(self.root, suites, scratch,
                        self.root_child(calls, status, missing))
                self.assertEqual(result[0]['verdict'], 'not_measured')
                self.assertEqual(subject.execution_code(result), 127)
        for output in ['', 'Ran 0 tests in 0s\n\nOK\n']:
            with self.assertRaises(subject.Refusal):
                subject.regression_counts('unittest', output)

    def test_root_new_unknown_type_and_duplicate_members_refuse_before_spawn(self):
        for members in [['dev-tools/new.test.ts'], ['src/a.spec.ts', 'src/a.spec.ts']]:
            with self.subTest(members=members), tempfile.TemporaryDirectory() as directory:
                scratch = Path(directory)
                for member in members:
                    p = self.root / member
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text('fixture only')
                with self.assertRaises(subject.Refusal):
                    subject.run_root_suites(self.root, subject.plan('.', members), scratch,
                        lambda *args: self.fail('invalid member spawned a child'))

    def test_root_raw_failure_and_timeout_keep_suffix_and_held_obligations(self):
        for code in [9, 124]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                scratch = Path(directory)
                members = ['scripts/a.test.sh', 'scripts/b.test.sh', 'test/app.e2e-spec.ts']
                for member in members:
                    p = self.root / member
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text('fixture only')
                calls = []
                def child(argv, *args):
                    calls.append(argv)
                    return {'argv': argv, 'exit_code': code, 'output': 'fixture failure', 'duration_s': 0}
                with patch.object(subject.shutil, 'which', return_value='/fixture/runner'):
                    result = subject.run_root_suites(self.root, subject.plan('.', members), scratch, child)
                self.assertEqual(len(calls), 1)
                self.assertEqual(result[1]['held_members'], ['scripts/b.test.sh'])
                self.assertEqual(result[1]['executions'][0]['exit_code'], code)
                self.assertEqual(subject.execution_code(result), 1 if code == 9 else 124)

    def test_root_maintained_regression_commands_and_real_count_parsers(self):
        members = ['scripts/a.test.sh', 'scripts/a.test.mjs', 'dev-tools/a.spec.bats', 'dev-tools/test_a.py']
        for member in members:
            p = self.root / member
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('fixture only')
        commands = [subject.root_regression_command(self.root, member) for member in members]
        self.assertEqual([c[0][0] for c in commands], ['bash', 'node', 'bats', sys.executable])
        self.assertEqual(subject.regression_counts('unittest', 'Ran 2 tests in 0.1s\nOK (skipped=1)\n'),
                         {'passed': 1, 'failed': 0, 'skipped': 1})
        tap = '# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# cancelled 0\n# todo 0\n'
        self.assertEqual(subject.regression_counts('node-tap', tap)['skipped'], 1)
        for text in ['', tap + '# tests 2\n', tap.replace('# pass 1', '# pass 2')]:
            with self.assertRaises(subject.Refusal):
                subject.regression_counts('node-tap', text)

    def test_root_missing_physical_vitest_dependency_refuses_before_spawn(self):
        suites = self.root_dispatch_fixture(['src/a.spec.ts'])
        (self.root / 'node_modules/.bin/vitest').unlink()
        with patch.object(subject.shutil, 'which', return_value='/fixture/runner'):
            result = subject.run_root_suites(self.root, suites, self.root,
                lambda *args: self.fail('missing dependency spawned a child'))
        self.assertEqual(result[0]['verdict'], 'not_measured')
        self.assertIn('owned Vitest dependency', result[0]['executions'][0]['reason'])

    def test_root_source_escape_and_expected_failure_cannot_verify(self):
        suites = self.root_dispatch_fixture(['src/a.spec.ts'])
        path = self.root / 'src/a.spec.ts'
        path.unlink()
        path.symlink_to(Path(__file__))
        with self.assertRaises(subject.Refusal):
            subject.run_root_suites(self.root, suites, self.root,
                lambda *args: self.fail('escaped source spawned a child'))
        self.assertEqual(subject.regression_counts('unittest',
            'Ran 1 test in 0.1s\nOK (expected failures=1)\n')['skipped'], 1)


if __name__ == '__main__':
    unittest.main()
