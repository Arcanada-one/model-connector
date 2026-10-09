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
sys.path.insert(0, str(ROOT / 'scripts'))
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
        # No test may start a real store by accident; store-using tests pass `stores=` explicitly.
        unavailable = patch.object(subject, 'open_owned_stores',
                                   side_effect=subject.StoreUnavailable('fixture: no store'))
        unavailable.start()
        self.addCleanup(unavailable.stop)
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
        for name in ['graph-full-suite.sh', 'graph_full_suite.py', 'owned_stores.py']:
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

    def compose_script(self, docker_body):
        """Run the real script with a PATH whose `docker` is a classifier control, not a Compose stand-in."""
        bindir = self.root / 'ctl-bin'
        bindir.mkdir(exist_ok=True)
        if docker_body is not None:
            (bindir / 'docker').write_text('#!/bin/sh\n' + docker_body)
            (bindir / 'docker').chmod(0o755)
        path = str(bindir) + ':' + os.path.dirname(sys.executable) + ':/usr/bin:/bin'
        if docker_body is None:
            path = str(bindir) + ':' + '/usr/bin:/bin'
            # /usr/bin may hold a real docker; the control for a missing tool hides it by name.
            (bindir / 'docker').write_text('')
            (bindir / 'docker').unlink()
        env = {'PATH': path, 'HOME': str(self.root)}
        return subprocess.run(['bash', str(ROOT / 'deploy/compose-network.test.sh')], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=60)

    def test_compose_contract_failures_are_classified_not_collapsed(self):
        cases = [
            ('echo "docker: \'compose\' is not a docker command." >&2; exit 1', 127, 'compose_plugin_missing'),
            ('[ "$1" = compose ] && [ "$2" = version ] && { echo "docker: unknown command: docker compose" >&2; exit 1; }\n'
             'echo "unknown flag: --project-directory" >&2; exit 125', 127, 'compose_plugin_missing'),
            ('[ "$1" = compose ] && [ "$2" = version ] && { echo fixture; exit 0; }\n'
             'echo "yaml: line 3: could not find expected key TOKEN=hunter2" >&2; exit 15', 1, 'compose_render_failed'),
            ('[ "$1" = compose ] && [ "$2" = version ] && { echo fixture; exit 0; }\n'
             'echo \'{"services":{"model-connector":{"networks":{},"ports":[]}},"networks":{}}\'', 1,
             'contract_assertion_failed'),
        ]
        for body, code, kind in cases:
            with self.subTest(kind=kind):
                done = self.compose_script(body)
                self.assertEqual(done.returncode, code, done.stdout + done.stderr)
                self.assertIn('[' + kind + ']', done.stderr)
                self.assertNotIn('hunter2', done.stderr)
        render = self.compose_script(next(b for b, _, k in cases if k == 'compose_render_failed'))
        self.assertIn('could not find expected key', render.stderr)  # sanitized child stderr is retained
        self.assertIn('docker binary:', render.stdout)  # tool record is printed
        self.assertIn('sha256', render.stdout)

    def pinned_source_fixture(self):
        names = [subject.PINNED_BILLING_SOURCE, subject.BILLING_MODULE_PINS,
                 'test/fixtures/billing-3a-source.tar.gz']
        for name in names:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_bytes((ROOT / name).read_bytes())
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', *names], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture',
                        '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        scratch = self.root / 'private'
        scratch.mkdir(mode=0o700)
        return scratch

    def test_pinned_billing_source_unpacks_only_after_every_byte_matches_its_pin(self):
        scratch = self.pinned_source_fixture()
        directory = Path(subject.unpack_pinned_billing_source(self.root, scratch))
        pins = json.loads((self.root / subject.BILLING_MODULE_PINS).read_text())
        self.assertEqual(sorted(p.name for p in directory.iterdir()), sorted(pins))

    def test_pinned_billing_source_tamper_refuses_and_absence_is_not_a_pass(self):
        scratch = self.pinned_source_fixture()
        pins = self.root / subject.BILLING_MODULE_PINS
        document = json.loads(pins.read_text())
        document['journal.py'] = '0' * 64
        pins.write_text(json.dumps(document))
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=F', '-c', 'user.email=f@example.invalid',
                        'commit', '-qam', 'tamper'], check=True)
        with self.assertRaises(subject.Refusal):
            subject.unpack_pinned_billing_source(self.root, scratch)
        (self.root / subject.PINNED_BILLING_SOURCE).unlink()
        self.assertIsNone(subject.unpack_pinned_billing_source(self.root, self.root / 'private2'))

    @staticmethod
    def no_stores(home, path):
        raise subject.StoreUnavailable('fixture: no store on this runner')

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
            result = subject.run_root_suites(self.root, suites, self.root, self.root_child(calls),
                                             stores=self.no_stores)
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

    class FakeOwned:
        closed = 0

        def environment(self):
            return {'DATABASE_URL': 'postgresql://fixture@localhost/fixture?host=/fixture',
                    'REDIS_HOST': '127.0.0.1', 'REDIS_PORT': '1', 'MC_OWNED_STORES': '1'}

        def describe(self):
            return {'postgres': 'fixture', 'redis': 'fixture', 'torn_down_in_finally': True}

        def close(self):
            type(self).closed += 1

    def owned_executor(self, calls, status='passed', boom=False):
        def child(argv, cwd, env, deadline, scratch, name):
            calls.append((argv, dict(env)))
            if boom and '--outputFile' in ' '.join(argv):
                raise OSError('fixture executor crash')
            if argv[:3] == ['pnpm', 'exec', 'vitest']:
                output = next(a.split('=', 1)[1] for a in argv if a.startswith('--outputFile='))
                members = argv[argv.index('--outputFile=' + output) + 1:]
                Path(output).write_text(json.dumps({
                    'numTotalTests': len(members), 'numFailedTests': int(status == 'failed'),
                    'numPassedTests': len(members) - int(status == 'failed'),
                    'testResults': [{'name': str(self.root / m), 'assertionResults': [{'status': status}]}
                                    for m in members]}))
            return {'argv': argv, 'exit_code': 0, 'output': '', 'duration_s': 0}
        return child

    def test_app_e2e_runs_against_owned_stores_and_tears_them_down(self):
        suites = self.root_dispatch_fixture(['test/app.e2e-spec.ts'])
        self.FakeOwned.closed = 0
        calls = []
        with patch.object(subject.shutil, 'which', return_value='/fixture/runner'):
            result = subject.run_root_suites(self.root, suites, self.root, self.owned_executor(calls),
                                             stores=lambda home, path: self.FakeOwned())
        self.assertEqual(result[0]['verdict'], 'verified')
        self.assertEqual(self.FakeOwned.closed, 1)
        self.assertNotIn('held_members', result[0])
        steps = [argv[2:4] for argv, _ in calls]
        self.assertEqual(steps, [['prisma', 'generate'], ['prisma', 'migrate'], ['vitest', 'run']])
        self.assertIn('vitest.e2e.config.ts', calls[-1][0])
        self.assertTrue(all(env.get('DATABASE_URL', '').endswith('host=/fixture') for _, env in calls))
        self.assertEqual(subject.execution_code(result), 0)

    def test_app_e2e_failure_is_failed_and_stores_still_torn_down(self):
        suites = self.root_dispatch_fixture(['test/app.e2e-spec.ts'])
        self.FakeOwned.closed = 0
        with patch.object(subject.shutil, 'which', return_value='/fixture/runner'):
            result = subject.run_root_suites(self.root, suites, self.root,
                                             self.owned_executor([], status='failed'),
                                             stores=lambda home, path: self.FakeOwned())
        self.assertEqual(result[0]['verdict'], 'failed')
        self.assertEqual(self.FakeOwned.closed, 1)
        self.assertEqual(subject.execution_code(result), 1)
        second = self.root / 'second'
        second.mkdir(mode=0o700)
        with patch.object(subject.shutil, 'which', return_value='/fixture/runner'):
            with self.assertRaises(OSError):
                subject.run_root_suites(self.root, suites, second, self.owned_executor([], boom=True),
                                        stores=lambda home, path: self.FakeOwned())
        self.assertEqual(self.FakeOwned.closed, 2)

    def test_app_e2e_without_stores_is_not_measured_never_verified(self):
        suites = self.root_dispatch_fixture(['test/app.e2e-spec.ts'])
        calls = []
        with patch.object(subject.shutil, 'which', return_value='/fixture/runner'):
            result = subject.run_root_suites(self.root, suites, self.root, self.owned_executor(calls),
                                             stores=self.no_stores)
        self.assertEqual(result[0]['verdict'], 'not_measured')
        self.assertEqual(calls, [])
        self.assertIn('owned disposable store unavailable', result[0]['executions'][0]['reason'])
        self.assertEqual(subject.execution_code(result), 127)

    def test_owned_store_integration_and_external_arms_are_classified_exactly(self):
        names = sorted(subject.OWNED_STORE_INTEGRATION | set(subject.EXTERNAL_ARMS))
        rows = {r['suite']: r for r in subject.plan('.', names)}
        self.assertEqual(rows['maintained-external-live']['members'], sorted(subject.EXTERNAL_ARMS))
        self.assertEqual(rows['maintained-integration']['members'], sorted(subject.OWNED_STORE_INTEGRATION))
        self.assertTrue(all(c in ('live_external_service', 'native_binary')
                            for c, _ in subject.EXTERNAL_ARMS.values()))
        suites = self.root_dispatch_fixture(sorted(subject.EXTERNAL_ARMS))
        result = subject.run_root_suites(self.root, suites, self.root,
                                         lambda *a: self.fail('an external arm spawned a child'),
                                         stores=self.no_stores)
        self.assertEqual(result[0]['verdict'], 'not_measured')
        self.assertEqual(sorted(result[0]['classification']), sorted(subject.EXTERNAL_ARMS))
        self.assertEqual(subject.execution_code(result), 127)

    def test_held_bench_file_measures_only_what_needs_no_native_binary(self):
        bench = 'src/bench-reservation/postgres.integration.spec.ts'
        suites = self.root_dispatch_fixture([bench])
        provisioned = []

        class Pg:
            socket_dir = '/fixture/mc-owned-postgres/socket'
            closers = []
            url = 'postgresql://dev@localhost/x?host=/fixture'

            def provision_bench_fixture(self):
                provisioned.append(True)

        class Owned(self.FakeOwned):
            pg = Pg()
            closed = 0
        calls = []
        with patch.object(subject.shutil, 'which', return_value='/fixture/runner'):
            result = subject.run_root_suites(self.root, suites, self.root, self.owned_executor(calls),
                                             stores=lambda home, path: Owned())
        row = result[0]
        self.assertEqual(row['verdict'], 'not_measured')  # the file as a whole is never verified
        self.assertEqual(row['held_members'], [bench])
        vitest = [(a, e) for a, e in calls if a[2:4] == ['vitest', 'run']][0]
        self.assertIn('-t', vitest[0])
        self.assertEqual(vitest[0][vitest[0].index('-t') + 1], subject.BENCH_PARTIAL[bench])
        self.assertTrue(vitest[1]['BENCH_OWNED_TEST_PG_SOCKET'].endswith('/mc-owned-postgres/socket'))
        self.assertNotIn('BENCH_OWNED_NATIVE_TEST_BINARY', vitest[1])
        self.assertEqual(provisioned, [True])
        self.assertEqual(Owned.closed, 1)
        for closer in Owned.pg.closers:  # the fake store stands in for OwnedPostgres.close()
            closer()

    def test_unclassified_integration_spec_is_held_not_run(self):
        suites = self.root_dispatch_fixture(['src/new/thing.integration.spec.ts'])
        result = subject.run_root_suites(self.root, suites, self.root,
                                         lambda *a: self.fail('unclassified spec spawned a child'),
                                         stores=lambda *a: self.fail('unclassified spec opened a store'))
        self.assertEqual(result[0]['verdict'], 'not_measured')
        self.assertEqual(result[0]['held_members'], ['src/new/thing.integration.spec.ts'])

    def test_owned_store_refuses_without_binaries_or_container_runtime(self):
        import owned_stores
        with patch.object(owned_stores, '_which', return_value=None), \
                patch.object(owned_stores, '_docker_ready', return_value=None):
            with self.assertRaises(owned_stores.StoreUnavailable):
                owned_stores.OwnedPostgres(self.root, os.defpath)
            with self.assertRaises(owned_stores.StoreUnavailable):
                owned_stores.OwnedRedis(self.root, os.defpath)

    def test_s3_contract_stub_refuses_unsigned_and_mis_signed_requests(self):
        import urllib.error
        import urllib.request
        credentials = {'R2_ACCESS_KEY_ID': 'stubkey', 'R2_SECRET_ACCESS_KEY': 'stubsecret'}
        (self.root / 'home').mkdir()
        stub = subject.open_s3_stub(self.root, os.environ.get('PATH', os.defpath), credentials)
        self.addCleanup(stub.close)
        url = 'http://127.0.0.1:%d/bucket/images/x.png' % stub.port
        forged = ('AWS4-HMAC-SHA256 Credential=stubkey/20260101/auto/s3/aws4_request, '
                  'SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=' + '0' * 64)
        for headers in ({}, {'Authorization': forged, 'x-amz-date': '20260101T000000Z',
                             'x-amz-content-sha256': 'UNSIGNED-PAYLOAD'}):
            request = urllib.request.Request(url, data=b'payload', method='PUT', headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request, timeout=10)
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()


if __name__ == '__main__':
    unittest.main()
