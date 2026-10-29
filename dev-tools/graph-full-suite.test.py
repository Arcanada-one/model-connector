"""Focused orchestration controls only, never the four complete product suites."""
from pathlib import Path
import hashlib
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
            self.assertEqual(
                (ROOT / unit / argv[1]).resolve(), ROOT / 'scripts/graph-full-suite-isolated.sh'
            )
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

    def template_source_fixture(self):
        names = ['templates/api-connector-scaffold/README.md',
                 'templates/api-connector-scaffold/{{name}}.connector.ts',
                 subject.AUTHORED_TEMPLATE, 'vitest.config.ts',
                 'src/connectors/base-api.connector.ts',
                 'src/connectors/interfaces/connector.interface.ts']
        for name in names:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', *names], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture',
                        '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        scratch = self.root / 'private'
        scratch.mkdir(mode=0o700)
        return scratch

    def test_authored_template_is_exact_distinct_obligation_not_prefix_omission(self):
        members = ['src/a.spec.ts', subject.AUTHORED_TEMPLATE,
                   'templates/new/new.spec.ts']
        rows = subject.plan('.', members)
        groups = {r['suite']: r['members'] for r in rows}
        self.assertEqual(groups['maintained-authored-template'], [subject.AUTHORED_TEMPLATE])
        self.assertEqual(groups['maintained-vitest'], ['src/a.spec.ts', 'templates/new/new.spec.ts'])
        self.assertEqual(sorted(n for r in rows for n in r['members']), sorted(members))

    def test_authored_template_render_binds_actual_sources_and_keeps_assertions(self):
        scratch = self.template_source_fixture()
        result = subject.render_authored_template(self.root, scratch, [subject.AUTHORED_TEMPLATE])
        self.assertEqual(len(result['source_bindings']), 6)
        self.assertEqual(len(result['rendered_files']), 2)
        source = (ROOT / subject.AUTHORED_TEMPLATE).read_text()
        actual = (result['target'] / 'scaffoldprobe.connector.spec.ts').read_text()
        self.assertEqual(actual.count('it('), source.count('it('))
        self.assertNotIn('{{', actual)
        self.assertIn('probe-secondary', actual)
        self.assertIn('vi.stubGlobal', actual)
        self.assertIn('unmocked scaffold fetch refused',
                      (result['target'] / 'no-network.mjs').read_text())
        with self.assertRaises(subject.Refusal):
            subject.render_authored_template(self.root, scratch, ['templates/new/new.spec.ts'])

    def test_authored_template_uncommitted_dependency_refuses(self):
        scratch = self.template_source_fixture()
        (self.root / 'templates/api-connector-scaffold/README.md').write_text('changed')
        with self.assertRaises(subject.Refusal):
            subject.render_authored_template(self.root, scratch, [subject.AUTHORED_TEMPLATE])

    def test_authored_template_unknown_placeholder_refuses_even_if_committed(self):
        scratch = self.template_source_fixture()
        path = self.root / subject.AUTHORED_TEMPLATE
        path.write_text(path.read_text() + '\n// {{UNKNOWN}}\n')
        subprocess.run(['git', '-C', str(self.root), 'add', subject.AUTHORED_TEMPLATE], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture',
                        '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'unknown'], check=True)
        with self.assertRaises(subject.Refusal):
            subject.render_authored_template(self.root, scratch, [subject.AUTHORED_TEMPLATE])

    def test_authored_template_rendered_tamper_cannot_be_verified(self):
        scratch = self.template_source_fixture()
        runner = self.root / 'node_modules/.bin/vitest'
        runner.parent.mkdir(parents=True)
        runner.touch()
        def executor(argv, cwd, env, deadline, private, name):
            target = private / 'authored-template'
            report = {'success': True, 'numTotalTests': 1, 'numPassedTests': 1,
                      'numFailedTests': 0, 'testResults': [{
                          'name': str(target / 'scaffoldprobe.connector.spec.ts'),
                          'assertionResults': [{'status': 'passed'}]}]}
            (target / 'result.json').write_text(json.dumps(report))
            with (target / 'scaffoldprobe.connector.ts').open('a') as stream:
                stream.write('/* tamper */')
            return {'argv': argv, 'exit_code': 0, 'output': ''}
        with patch.object(subject.shutil, 'which', return_value='/owned/tool'):
            rows = subject.run_root_suites(self.root,
                subject.plan('.', [subject.AUTHORED_TEMPLATE]), scratch, executor)
        self.assertEqual(rows[0]['verdict'], 'not_measured')
        self.assertEqual(rows[0]['executions'][0]['reason'], 'rendered execution source changed')

    def test_authored_template_source_read_uses_private_home_without_ambient_home(self):
        scratch = self.template_source_fixture()
        with patch.dict(os.environ, {}, clear=True):
            result = subject.render_authored_template(self.root, scratch, [subject.AUTHORED_TEMPLATE])
        self.assertEqual(len(result['source_bindings']), 6)
        self.assertEqual((scratch / 'template-git-home').stat().st_mode & 0o777, 0o700)

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

    def test_isolated_entrypoint_provisions_private_tmpdir_and_preserves_exit_status(self):
        scripts = self.root / 'scripts'
        scripts.mkdir()
        (self.root / 'node_modules').mkdir()
        (scripts / 'graph-full-suite-isolated.sh').write_bytes(
            (ROOT / 'scripts/graph-full-suite-isolated.sh').read_bytes())
        runner = scripts / 'graph-full-suite.sh'
        runner.write_text(
            '#!/usr/bin/env bash\n'
            '[[ "$1" == . ]] || exit 9\n'
            'printf "%s\\n%s\\n%s\\n" "$TMPDIR" "$HOME" "$(stat -c %a "$TMPDIR")"\n'
            '[[ -z "${FIXTURE_SECRET:-}" ]] || exit 10\n'
            'exit 23\n'
        )
        result = subprocess.run(
            ['bash', 'scripts/graph-full-suite-isolated.sh', '.'],
            cwd=self.root,
            env={'PATH': os.defpath, 'HOME': str(self.root), 'FIXTURE_SECRET': 'must-not-leak'},
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 23, result.stdout + result.stderr)
        tempdir, home, mode = result.stdout.strip().splitlines()
        self.assertEqual(mode, '700')
        self.assertEqual(Path(home).parent.parent, self.root / 'node_modules/.cache/graph-full-suite/runs')
        self.assertFalse(Path(tempdir).exists())
        self.assertEqual(Path(tempdir).parent, Path('/tmp'))
        self.assertNotIn('must-not-leak', result.stdout + result.stderr)

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
                members = [a for a in argv[argv.index('--outputFile=' + output) + 1:]
                           if not a.startswith('-')]
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
        full_vitest_calls = [args for args in calls if args[0] == 'pnpm' and '--maxWorkers=4' in args]
        self.assertEqual(len(full_vitest_calls), 1)
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


class ArmEvidence(unittest.TestCase):
    """Opt-in FullSuiteArmEvidence/v1 emitter. Red controls run through the AUP gate when AUP_GATE_TOOLS is set."""
    UNIT = 'deployable_unit:.'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        self.profile = (ROOT / '.arcana/verify.json').read_bytes()
        arms = json.loads(self.profile)['deployables']['.']['full_test_arms']
        self.defined = {a['name']: a['requires'] for a in arms}
        self.git('init', '-q')
        (self.root / '.arcana').mkdir()
        (self.root / '.arcana/verify.json').write_bytes(self.profile)
        self.base = self.commit('base')
        (self.root / 'x.txt').write_text('head')
        self.head = self.commit('head')

    def git(self, *args):
        env = dict(os.environ, HOME=self.temp.name, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
        return subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', *args],
                              check=True, capture_output=True, env=env).stdout.decode().strip()

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def row(self, backend, total=3, skipped=0, exit_code=0, control='PASS_RED'):
        row = {'exit': exit_code, 'backend': backend,
               'counts': {'total': total, 'passed': total - skipped, 'failed': 0, 'skipped': skipped}}
        if control:
            row['connectivity_control'] = {'result': control}
        return row

    def executor_files(self, head=None, overrides=None, drop=(), env=('RUN_INTEGRATION',)):
        """Synthetic executor results in the retained KCP0027ArmExecution shape, one multi-arm file."""
        gates = {g for name in self.defined for g in subject.ARM_ENV_GATES.get(name, ())}
        arms = {}
        for name, slot in self.defined.items():
            backend = {'real_disposable': 'real(disposable local postgres16)',
                       'real_external': 'real(external provider)', 'stub_ok': 'stub(local loopback)'}[slot]
            arms[name] = self.row(backend)
        for name, patch_ in (overrides or {}).items():
            arms[name] = patch_ if 'counts' in patch_ else {**arms[name], **patch_}
        for name in drop:
            arms.pop(name)
        document = {'schema': 'KCP0027ArmExecution/v1', 'worktree_head': head or self.head, 'arms': arms,
                    'env_keys_set': sorted(gates | set(env))}
        path = Path(self.temp.name) / 'executor.json'
        path.write_text(json.dumps(document))
        return str(path)

    def emit(self, files, base=None, extra=None):
        environ = {subject.ARM_EVIDENCE_ENV: files, subject.ARM_BASE_ENV: base or self.base, **(extra or {})}
        return subject.arm_evidence(self.root, self.head, environ)

    def gate(self, evidence, claim_verified=True):
        tools = os.environ.get('AUP_GATE_TOOLS')
        if not tools:
            self.skipTest('AUP_GATE_TOOLS not set')
        sys.path.insert(0, tools)
        self.addCleanup(sys.path.remove, tools)
        import impact, impact_pair  # noqa: E401
        shipped = {k: v for k, v in evidence.items() if k != 'notes'}
        doc = {'admission': {'verdict': 'admitted_with_exemptions'}, 'change_set': {'head': self.head, 'base': self.base},
               'verdicts': [{'entity': self.UNIT, 'verdict': 'verified', 'verifier_ids': ['v']}],
               'verifiers': [{'id': 'v', 'kind': 'targeted_test', 'scope': 'global_fallback_full_suite',
                              'entities': [self.UNIT], 'exit_code': 0, 'output_ref': 'o',
                              'entity_verdicts': {self.UNIT: 'verified'}, 'arms': shipped}]}
        return impact_pair.fallback_arm_problems(impact.Repo(self.root), self.base, self.head, doc, {self.UNIT}, self.base)

    def test_no_opt_in_emits_nothing(self):
        self.assertIsNone(subject.arm_evidence(self.root, self.head, {}))
        self.assertIsNone(subject.arm_evidence(self.root, self.head, {subject.ARM_BASE_ENV: self.base}))

    def test_complete_synthetic_set_is_accepted_by_the_gate(self):
        evidence = self.emit(self.executor_files())
        self.assertEqual(evidence['not_run'], [])
        self.assertEqual(sorted(a['name'] for a in evidence['arms']), sorted(self.defined))
        self.assertEqual(evidence['definition']['sha256'], hashlib.sha256(self.profile).hexdigest())
        self.assertEqual(self.gate(evidence), [])

    def test_missing_arm_is_not_run_and_the_gate_refuses_the_claim(self):
        evidence = self.emit(self.executor_files(drop=('app-e2e',)))
        self.assertEqual(evidence['not_run'], ['app-e2e'])
        self.assertTrue(self.gate(evidence))

    def test_wrong_head_in_executor_result_is_not_run(self):
        evidence = self.emit(self.executor_files(head='0' * 40))
        self.assertEqual(sorted(evidence['not_run']), sorted(self.defined))
        self.assertEqual(evidence['arms'], [])
        self.assertTrue(self.gate(evidence))

    def test_stub_in_a_real_slot_is_carried_faithfully_and_refused(self):
        evidence = self.emit(self.executor_files(overrides={'billing': {'backend': 'stub(local)'}}))
        self.assertEqual([a['backend'] for a in evidence['arms'] if a['name'] == 'billing'], ['stub'])
        self.assertTrue(self.gate(evidence))

    def test_skipped_tests_never_verify(self):
        evidence = self.emit(self.executor_files(overrides={'auth-rate-limit': self.row('real(disposable x)', skipped=1)}))
        arm = [a for a in evidence['arms'] if a['name'] == 'auth-rate-limit'][0]
        self.assertEqual(arm['verdict'], 'not_measured')
        self.assertTrue(self.gate(evidence))

    def test_zero_tests_never_verify(self):
        evidence = self.emit(self.executor_files(overrides={'billing': self.row('real(disposable x)', total=0)}))
        self.assertNotEqual([a['verdict'] for a in evidence['arms'] if a['name'] == 'billing'], ['verified'])
        self.assertTrue(self.gate(evidence))

    def test_missing_red_control_never_verifies(self):
        evidence = self.emit(self.executor_files(overrides={'billing': self.row('real(disposable x)', control=None)}))
        self.assertNotEqual([a['verdict'] for a in evidence['arms'] if a['name'] == 'billing'], ['verified'])
        self.assertTrue(self.gate(evidence))

    def test_failed_arm_is_reported_failed(self):
        row = self.row('real(disposable x)')
        row['counts'].update(passed=2, failed=1)
        row['exit'] = 1
        evidence = self.emit(self.executor_files(overrides={'billing': row}))
        self.assertEqual([a['verdict'] for a in evidence['arms'] if a['name'] == 'billing'], ['failed'])

    def test_definition_sha_mismatch_is_refused_by_the_gate(self):
        evidence = self.emit(self.executor_files())
        evidence['definition'] = dict(evidence['definition'], sha256='0' * 64)
        self.assertTrue(self.gate(evidence))

    def test_env_gated_arm_without_named_gate_variables_is_not_run(self):
        document = json.loads(Path(self.executor_files()).read_text())
        document['env_keys_set'] = ['RUN_INTEGRATION']          # VERTEX_SERVICE_ACCOUNT_JSON not named as set
        path = Path(self.temp.name) / 'gated.json'
        path.write_text(json.dumps(document))
        evidence = self.emit(str(path))
        self.assertIn('image-router-fallback', evidence['not_run'])
        self.assertIn('vertex-auth', evidence['not_run'])
        self.assertTrue(self.gate(evidence))

    def test_duplicate_evidence_for_one_arm_counts_for_neither(self):
        first = self.executor_files()
        copy = Path(self.temp.name) / 'copy.json'
        copy.write_text(Path(first).read_text())
        evidence = self.emit(first + os.pathsep + str(copy))
        self.assertEqual(sorted(evidence['not_run']), sorted(self.defined))

    def test_refuses_without_base_or_with_a_base_lacking_the_definition(self):
        self.assertIn('refused', subject.arm_evidence(self.root, self.head, {subject.ARM_EVIDENCE_ENV: self.executor_files()}))
        (self.root / '.arcana/verify.json').write_text('{}')
        bad = self.commit('empty definition')
        self.assertIn('refused', self.emit(self.executor_files(), base=bad))

    def test_relative_or_unreadable_evidence_path_is_ignored_not_trusted(self):
        evidence = self.emit('relative.json')
        self.assertEqual(sorted(evidence['not_run']), sorted(self.defined))
        self.assertEqual(evidence['arms'], [])

    def test_executor_a3_and_a4_shapes_map_to_the_defined_names(self):
        a3 = {'arm': 'app-e2e', 'worktree_head': self.head, 'backend': 'real(disposable local postgres16 + redis)',
              'env_keys_set': ['DEEPSEEK_API_KEY'], 'run': {'exit': 0, 'counts': {'total': 3, 'passed': 3, 'failed': 0, 'skipped': 0}},
              'controls': {'one': {'result': 'PASS_RED'}, 'two': {'result': 'PASS_RED'}}}
        a4 = {'arm': 'image-router-fallback', 'worktree_head': self.head, 'backend': {'provider': 'none'},
              'env_keys_set': ['RUN_INTEGRATION'], 'run': {'exit': 0, 'counts': {'total': 7, 'passed': 7, 'failed': 0, 'skipped': 0}},
              'controls': {'one': {'result': 'PASS_RED'}}}
        paths = []
        for index, document in enumerate((a3, a4)):
            path = Path(self.temp.name) / ('a%d.json' % index)
            path.write_text(json.dumps(document))
            paths.append(str(path))
        evidence = self.emit(os.pathsep.join(paths))
        by_name = {a['name']: a for a in evidence['arms']}
        self.assertEqual(by_name['app-e2e']['backend'], 'real_disposable')
        self.assertEqual(by_name['app-e2e']['control'], {'result': 'PASS_RED'})
        self.assertNotIn('image-router-fallback', by_name)       # DEC-AUP-0170 item 5: gate variable not named
        self.assertIn('image-router-fallback', evidence['not_run'])
        self.assertEqual(self.gate(evidence) != [], True)

    def test_default_main_path_adds_no_arms_key(self):
        source = (ROOT / 'scripts/graph_full_suite.py').read_text()
        self.assertIn("if unit == '.' and os.environ.get(ARM_EVIDENCE_ENV):", source)


if __name__ == '__main__':
    unittest.main()
