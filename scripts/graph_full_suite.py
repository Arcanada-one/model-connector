"""Maintain complete source membership and emit Program FullSuiteArmEvidence/v1.

Every defined full_test_arms slot must carry exact execution evidence (counts with
skipped=0, head binding, and PASS_RED for non-stub backends). Arms are never parked
in `not_run` to dodge measurement. Live opt-in provider matrices stay outside this
harness; real_* slots run owned disposable/external probes under this runner.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

AUTHORED_TEMPLATE = 'templates/api-connector-scaffold/{{name}}.connector.spec.ts'

UNITS = ('.', 'packages/sdk-python', 'packages/sdk-ts', 'watcher')
ROOT = Path(__file__).resolve().parents[1]
ENV_FILES = ('.env', '.env.local', '.env.integration', '.env.test')
# Reviewed existing fake-connector/MSW contracts, never a provider/storage grant.
OFFLINE_INTEGRATION = frozenset({
    'src/connectors/cascade/cascade-router.fallback.integration.spec.ts',
    'src/openai-compat/openai-compat.failover.integration.spec.ts',
    'src/speech/stt/stt-pilot.integration.spec.ts',
})
ARM_BACKEND_OF = {
    'vitest-default': 'stub',
    'integration-offline-contracts': 'stub',
    'authored-template': 'stub',
    'regression': 'stub',
    'integration-disposable-store': 'real_disposable',
    'integration-external-provider': 'real_external',
    'app-e2e': 'real_disposable',
}


class Refusal(Exception):
    """Invalid source, membership, path or execution result."""


def checked_file(root, relative):
    path = root / relative
    for part in (path, *path.parents):
        if part == root:
            break
        if part.is_symlink():
            raise Refusal('symlink in source path')
    if not path.is_file() or root not in path.resolve().parents:
        raise Refusal('missing or escaped source file')
    return path


def check_context(root, unit, cwd):
    if unit not in UNITS or cwd.resolve() != (root / unit).resolve():
        raise Refusal('unit/cwd mismatch')
    # Refuse physical indirection, including a symlinked package directory.
    probe = root / unit
    while probe != root:
        if probe.is_symlink():
            raise Refusal('symlinked deployable')
        probe = probe.parent
    for base in {root, root / unit}:
        for name in ENV_FILES:
            if os.path.lexists(base / name):
                raise Refusal('ambient dotenv refused')


def test_member(name):
    if name.startswith(('receipts/', 'node_modules/', '.arcana/')):
        return False
    return (bool(re.search(r'\.(?:spec|test)\.(?:ts|mjs|sh|bats|py)$', name))
            or name.endswith('.e2e-spec.ts') or name.endswith('.bats')
            or bool(re.search(r'(?:^|/)test_[^/]+\.py$', name))
            or name == 'dev-tools/credential-docs-regression.sh')


def inventory(root):
    top = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'],
                         capture_output=True, check=True).stdout.decode().strip()
    if Path(top).resolve() != root.resolve():
        raise Refusal('source root is not repository root')
    other = subprocess.run(['git', '-C', str(root), 'ls-files', '--others',
                            '--exclude-standard', '-z'], capture_output=True, check=True)
    if any(test_member(n) for n in other.stdout.decode().split('\0') if n):
        raise Refusal('uncommitted maintained membership')
    result = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'],
                            capture_output=True, check=True)
    names = sorted(n for n in result.stdout.decode().split('\0') if n and test_member(n))
    if not names:
        raise Refusal('empty maintained membership')
    rows = []
    for name in names:
        path = checked_file(root, name)
        source = path.read_bytes()
        # The declared revision, not an uncommitted test edit, owns this union.
        native = subprocess.run(['git', '-C', str(root), 'show', 'HEAD:' + name],
                                capture_output=True, check=True).stdout
        if native != source:
            raise Refusal('test membership differs from committed revision')
        rows.append({'path': name, 'sha256': hashlib.sha256(source).hexdigest()})
    return rows


def members_for(rows, unit):
    names = [row['path'] for row in rows]
    if unit == '.':
        return [n for n in names if not n.startswith(('watcher/', 'packages/'))]
    return [n for n in names if n.startswith(unit + '/')]


def plan(unit, members):
    if not members:
        raise Refusal('empty deployable membership')
    if unit == '.':
        # Preserve the entire maintained union. None of these rows is a PASS.
        groups = {}
        for name in members:
            if name == AUTHORED_TEMPLATE:
                group = 'maintained-authored-template'
            elif name.endswith('.integration.spec.ts') and name.startswith('src/'):
                group = 'maintained-integration'
            elif name.endswith('.e2e-spec.ts'):
                group = 'maintained-app-e2e'
            elif name == 'provider-profiles/fi10-persona-resolve.spec.mjs':
                # node:test membership — must not enter Vitest JSON evidence.
                group = 'maintained-regression'
            elif name.endswith('.spec.ts') or name.endswith('.spec.mjs'):
                group = 'maintained-vitest'
            else:
                group = 'maintained-regression'
            groups.setdefault(group, []).append(name)
        return [{'suite': key, 'members': value, 'verdict': 'not_measured',
                 'reason': 'root groups require actual execution and explicit held prerequisites'}
                for key, value in sorted(groups.items())]
    if unit == 'packages/sdk-python':
        if any(not n.endswith('.py') for n in members):
            raise Refusal('undeclared Python suite type')
        return [{'suite': 'pytest', 'members': members}]
    vitest = [n for n in members if n.endswith('.spec.ts')]
    bats = [n for n in members if n.endswith('.bats')]
    if set(vitest + bats) != set(members) or not vitest:
        raise Refusal('undeclared or empty suite type')
    suites = [{'suite': 'vitest', 'members': vitest}]
    if unit == 'watcher':
        if not bats:
            raise Refusal('watcher Bats membership missing')
        suites.extend([{'suite': 'build', 'members': []},
                       {'suite': 'bats', 'members': bats}])
    elif bats:
        raise Refusal('unexpected SDK shell suite')
    return suites


def clean_environment(scratch, unit_root, root=None):
    # No inherited tokens, flags, URLs, NODE_OPTIONS, PYTHONPATH or agent hooks.
    env = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(scratch / 'home'),
           'TMPDIR': str(scratch), 'CI': '1', 'NO_COLOR': '1', 'FORCE_COLOR': '0',
           'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': str(unit_root),
           'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1'}
    # Owned package tree only — arm probes import ioredis from the checkout.
    modules = (root or unit_root) / 'node_modules'
    if modules.is_dir() and not modules.is_symlink():
        env['NODE_PATH'] = str(modules)
    if any(not Path(part).is_absolute() for part in env['PATH'].split(os.pathsep)):
        raise Refusal('relative PATH entry')
    (scratch / 'home').mkdir(mode=0o700)
    return env


def execute(argv, cwd, env, deadline, scratch, name):
    """Bound only owned child process groups; retain raw exit124 and private logs."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {'argv': argv, 'exit_code': 124, 'output': '', 'duration_s': 0}
    started = time.monotonic()
    with (scratch / (name + '.log')).open('xb') as log:
        try:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        except FileNotFoundError:
            return {'argv': argv, 'exit_code': 127, 'output': '', 'duration_s': 0}
        try:
            code = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            code = 124
    return {'argv': argv, 'exit_code': code,
            'output': (scratch / (name + '.log')).read_text(errors='replace'),
            'duration_s': round(time.monotonic() - started, 3)}


def vitest_counts(document, expected, root):
    if document.get('success') is False:
        raise Refusal('Vitest explicitly refused success')
    rows = document.get('testResults')
    if not isinstance(rows, list) or not rows:
        raise Refusal('empty Vitest results')
    files, assertions = [], []
    for row in rows:
        path = Path(row['name']).resolve()
        if root not in path.parents:
            raise Refusal('escaped result path')
        files.append(path.relative_to(root).as_posix())
        cases = row.get('assertionResults', [])
        if not cases:
            raise Refusal('empty test file')
        assertions.extend(cases)
    if len(files) != len(set(files)) or set(files) != set(expected):
        raise Refusal('missing, duplicate or unexpected test file')
    counts = {'passed': sum(a.get('status') == 'passed' for a in assertions),
              'failed': sum(a.get('status') == 'failed' for a in assertions),
              'skipped': sum(a.get('status') in ('pending', 'skipped', 'todo') for a in assertions)}
    if (not assertions or sum(counts.values()) != len(assertions)
            or document.get('numTotalTests') != len(assertions)
            or document.get('numPassedTests') != counts['passed']
            or document.get('numFailedTests') != counts['failed']):
        raise Refusal('inconsistent or empty assertion counts')
    return counts


def pytest_counts(collection, xml, expected, unit):
    nodes = [line.strip() for line in collection.splitlines() if '::' in line and not line.startswith(' ')]
    files = {unit + '/' + n.split('::')[0] for n in nodes}
    if not nodes or len(nodes) != len(set(nodes)) or files != set(expected):
        raise Refusal('pytest collection membership mismatch')
    cases = ET.fromstring(xml).findall('.//testcase')
    wanted = {n.replace('.py::', '::').replace('/', '.').replace('::', '.') for n in nodes}
    observed = [c.get('classname', '') + '.' + c.get('name', '') for c in cases]
    if len(cases) != len(nodes) or len(set(observed)) != len(cases) or set(observed) != wanted:
        raise Refusal('pytest execution differs from collection')
    failures = sum(c.find('failure') is not None or c.find('error') is not None for c in cases)
    skipped = sum(c.find('skipped') is not None for c in cases)
    return {'passed': len(cases) - failures - skipped, 'failed': failures, 'skipped': skipped}


def bats_counts(output):
    lines = output.splitlines()
    plans = [int(m[1]) for line in lines if (m := re.fullmatch(r'1\.\.(\d+)', line))]
    tests = [line for line in lines if re.match(r'(?:not )?ok \d+(?: |$)', line)]
    ids = [int(re.match(r'(?:not )?ok (\d+)', line)[1]) for line in tests]
    if len(plans) != 1 or not tests or ids != list(range(1, plans[0] + 1)):
        raise Refusal('empty, duplicated or incomplete TAP')
    skipped = sum(bool(re.search(r'#\s*skip\b', line, re.I)) for line in tests)
    failures = sum(line.startswith('not ok') for line in tests)
    return {'passed': len(tests) - failures - skipped, 'failed': failures, 'skipped': skipped}


def run_suites(root, unit, suites, scratch, executor=execute):
    cwd = root / unit
    env = clean_environment(scratch, cwd)
    deadline = time.monotonic() + 900
    results = []
    for index, suite in enumerate(suites):
        name = suite['suite']
        report = scratch / (name + '.json')
        if name == 'vitest':
            argv = ['pnpm', 'exec', 'vitest', 'run', '--reporter=json', '--outputFile=' + str(report)]
        elif name == 'build':
            argv = ['pnpm', 'build']
        elif name == 'bats':
            argv = ['bats', '--formatter', 'tap', *[str(root / n) for n in suite['members']]]
        else:
            argv = [sys.executable, '-B', '-m', 'pytest', '-p', 'pytest_asyncio.plugin',
                    '-p', 'no:cacheprovider', '--collect-only', '-q', 'tests']
        result = executor(argv, cwd, env, deadline, scratch, str(index) + '-collection')
        raw = result.pop('output')
        if result['exit_code']:
            result.update(suite=name, verdict='not_measured' if result['exit_code'] in (124, 127) else 'failed')
            results.append(result)
            break
        if name == 'pytest':
            xml = scratch / 'pytest.xml'
            result = executor([sys.executable, '-B', '-m', 'pytest', '-p', 'pytest_asyncio.plugin',
                               '-p', 'no:cacheprovider', '-q', '--junitxml=' + str(xml), 'tests'],
                              cwd, env, deadline, scratch, str(index) + '-execution')
            result.pop('output')
            result['collection_argv'] = argv
            if result['exit_code']:
                result.update(suite=name, verdict='not_measured' if result['exit_code'] in (124, 127) else 'failed')
                results.append(result)
                break
            counts = pytest_counts(raw, xml.read_text(), suite['members'], unit)
        elif name == 'vitest':
            counts = vitest_counts(json.loads(report.read_text()), suite['members'], root)
        elif name == 'bats':
            counts = bats_counts(raw)
        else:
            counts = None
        result.update(suite=name, counts=counts, members=suite['members'],
                      verdict='failed' if counts and counts['failed'] else
                      'not_measured' if counts and (counts['skipped'] or not counts['passed'])
                      else 'verified')
        results.append(result)
        if result['verdict'] != 'verified':
            break
    # Any unexecuted suffix stays visible, not a dropped obligation.
    for suite in suites[len(results):]:
        results.append({**suite, 'verdict': 'not_measured', 'reason': 'preceding suite did not verify'})
    return results


def root_regression_command(root, member):
    path = str(checked_file(root, member))
    if member.endswith('.py'):
        return [sys.executable, '-B', path], 'unittest'
    if member.endswith('.test.mjs') or member.endswith('.spec.mjs'):
        return ['node', '--test', '--test-reporter=tap', path], 'node-tap'
    if member.endswith('.bats'):
        return ['bats', '--formatter', 'tap', path], 'bats'
    if member.endswith('.sh'):
        return ['bash', path], 'exit-status'
    raise Refusal('undeclared root regression type')


def regression_counts(kind, output):
    if kind == 'bats':
        return bats_counts(output)
    if kind == 'unittest':
        totals = re.findall(r'^Ran (\d+) tests? in ', output, re.M)
        if len(totals) != 1 or int(totals[0]) == 0 or not re.search(r'^OK(?: \(|$)', output, re.M):
            raise Refusal('missing or empty unittest counts')
        count = sum(int(v) for v in re.findall(r'(?:skipped|expected failures)=(\d+)', output))
        if count > int(totals[0]):
            raise Refusal('inconsistent unittest counts')
        return {'passed': int(totals[0]) - count, 'failed': 0, 'skipped': count}
    if kind == 'node-tap':
        counts = {}
        for key in ('tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'):
            values = re.findall(r'^# ' + key + r' (\d+)$', output, re.M)
            if len(values) != 1:
                raise Refusal('missing or duplicated Node TAP count')
            counts[key] = int(values[0])
        if not counts['tests'] or sum(counts[k] for k in ('pass', 'fail', 'skipped', 'cancelled', 'todo')) != counts['tests']:
            raise Refusal('inconsistent or empty Node TAP counts')
        return {'passed': counts['pass'], 'failed': counts['fail'] + counts['cancelled'],
                'skipped': counts['skipped'] + counts['todo']}
    # Existing shell validators have an exit-status contract, not invented counts.
    return None


def render_authored_template(root, scratch, members, env=None):
    """Render the exact README contract; retain authored and executed identities.

    This tests scaffold source with synthetic fetch fixtures, not adoption of a
    new provider. Unknown templates and unresolved substitutions fail closed.
    """
    if members != [AUTHORED_TEMPLATE]:
        raise Refusal('undeclared authored template membership')
    if env is None:
        home = scratch / 'template-git-home'
        home.mkdir(mode=0o700)
        env = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(home),
               'TMPDIR': str(scratch)}
    folder = 'templates/api-connector-scaffold/'
    sources = [folder + 'README.md', folder + '{{name}}.connector.ts', AUTHORED_TEMPLATE,
               'vitest.config.ts', 'src/connectors/base-api.connector.ts',
               'src/connectors/interfaces/connector.interface.ts']
    bindings = []
    for name in sources:
        data = checked_file(root, name).read_bytes()
        native = subprocess.run(['git', '-C', str(root), 'show', 'HEAD:' + name],
                                capture_output=True, check=True, env=env).stdout
        if data != native:
            raise Refusal('template dependency differs from committed revision')
        bindings.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest()})
    values = {'NAME': 'ScaffoldProbe', 'NAME_LOWER': 'scaffoldprobe',
              'ENV_KEY_PREFIX': 'SCAFFOLD_PROBE', 'BASE_URL': 'https://scaffold-probe.invalid',
              'DEFAULT_MODEL': 'probe-primary',
              'MODELS_LIST': "['probe-primary', 'probe-secondary']",
              'API_KEY_ENV': 'SCAFFOLD_PROBE_API_KEY',
              'TIMEOUT_ENV': 'SCAFFOLD_PROBE_TIMEOUT', 'COST_FIELD': '0'}
    target = scratch / 'authored-template'
    target.mkdir(mode=0o700)
    rendered = []
    for suffix in ('ts', 'spec.ts'):
        source = folder + '{{name}}.connector.' + suffix
        text = checked_file(root, source).read_text()
        for key, value in values.items():
            text = text.replace('{{' + key + '}}', value)
        text = text.replace('replace-me-alt-model', 'probe-secondary')
        if '{{' in text:
            raise Refusal('unresolved authored template placeholder')
        # Relocation only: imported production contracts stay in the source repo.
        if suffix == 'ts':
            for name in ('base-api.connector', 'interfaces/connector.interface'):
                old = "'../" + name + "'"
                if text.count(old) != 1:
                    raise Refusal('unknown scaffold import contract')
                text = text.replace(old, json.dumps(str(root / 'src/connectors' / name)))
        else:
            if text.count("from 'vitest'") != 1:
                raise Refusal('unknown scaffold test runner import')
            text = text.replace("from 'vitest'", 'from ' + json.dumps(
                str(root / 'node_modules/vitest/dist/index.js')))
        output = target / ('scaffoldprobe.connector.' + suffix)
        with output.open('x') as stream:
            stream.write(text)
        output.chmod(0o600)
        rendered.append({'source': source, 'path': str(output),
                         'sha256': hashlib.sha256(output.read_bytes()).hexdigest()})
    setup = target / 'no-network.mjs'
    setup.write_text("globalThis.fetch = () => { throw new Error('unmocked scaffold fetch refused'); };\n")
    setup.chmod(0o600)
    config = target / 'vitest.config.mjs'
    config.write_text('import original from ' + json.dumps(str(root / 'vitest.config.ts')) +
        '; export default {...original,test:{...original.test,root:' + json.dumps(str(target)) +
        ',include:["scaffoldprobe.connector.spec.ts"],exclude:[],setupFiles:[' +
        json.dumps(str(setup)) + ']}};\n')
    config.chmod(0o600)
    return {'authored_members': members, 'source_bindings': bindings,
            'rendered_files': rendered, 'substitutions': values,
            'verification_kind': 'README-rendered scaffold assertions with mocked transport',
            'generated_support': [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                                  for p in (setup, config)],
            'target': target, 'config': config}


def run_root_suites(root, suites, scratch, executor=execute):
    """Dispatch ordinary local groups; preserve every held member without spawning it."""
    members = [n for suite in suites for n in suite['members']]
    expected = {r['suite']: r['members'] for r in plan('.', members)}
    if (len(members) != len(set(members)) or len(suites) != len(expected)
            or {r['suite']: r['members'] for r in suites} != expected):
        raise Refusal('missing, duplicate or misclassified root membership')
    # Resolve every owned source path/type before any local child can be spawned.
    for suite in suites:
        for member in suite['members']:
            checked_file(root, member)
            if suite['suite'] == 'maintained-regression':
                root_regression_command(root, member)
    env = clean_environment(scratch, root, root=root)
    # Owned disposable Redis for real_* arm probes (never inherited secrets).
    env['REDIS_HOST'] = '127.0.0.1'
    env['REDIS_PORT'] = '6379'
    env['REDIS_PREFIX'] = 'mc-full-suite:' + str(os.getpid()) + ':'
    deadline = time.monotonic() + 900
    results = []
    real_arm_executions = {}
    def run(argv, members, name, parser, expect_failure=False):
        required = [argv[0]]
        if members == ['deploy/compose-network.test.sh']:
            required.append('docker')  # Compose config only, never start or stop.
        missing = [tool for tool in required if not shutil.which(tool, path=env['PATH'])]
        if argv[0] == 'pnpm' and not (root / 'node_modules/.bin/vitest').is_file():
            missing.append('owned Vitest dependency')
        if missing:
            return {'argv': argv, 'members': members, 'verdict': 'not_measured',
                    'exit_code': 127, 'reason': 'missing local runner: ' + ', '.join(missing)}
        result = executor(argv, root, env, deadline, scratch, name)
        raw = result.pop('output')
        code = result['exit_code']
        result.update(members=members, raw_log=str(scratch / (name + '.log')),
                      verdict='not_measured' if code in (124, 127) else 'failed' if code else 'verified')
        if expect_failure:
            if code and code not in (124, 127):
                try:
                    counts = parser(raw)
                except (Refusal, ValueError, KeyError, OSError, json.JSONDecodeError):
                    counts = {'passed': 0, 'failed': 1, 'skipped': 0}
                result['counts'] = counts
                result['verdict'] = 'verified'  # red control observed
            else:
                result.update(verdict='not_measured', reason='PASS_RED control did not fail')
            return result
        if not code:
            try:
                counts = parser(raw)
            except (Refusal, ValueError, KeyError, OSError, json.JSONDecodeError):
                result.update(verdict='not_measured', reason='missing or invalid exact execution evidence')
            else:
                result['counts'] = counts
                if counts and (counts['failed'] or counts['skipped'] or not counts['passed']):
                    result['verdict'] = 'failed' if counts['failed'] else 'not_measured'
        return result

    def probe_counts(raw):
        lines = [line for line in raw.splitlines() if line.startswith('{')]
        if not lines:
            raise Refusal('arm probe emitted no JSON counts')
        document = json.loads(lines[-1])
        if set(document) != {'passed', 'failed', 'skipped'}:
            raise Refusal('arm probe counts keys invalid')
        for key, value in document.items():
            if type(value) is not int or value < 0:
                raise Refusal('arm probe counts must be non-negative integers')
        return document

    def run_pass_red_probe(script_rel, arm_name, index_tag):
        script = checked_file(root, script_rel)
        green = run(['node', str(script), 'green'], [script_rel], index_tag + '-green', probe_counts)
        red = run(['node', str(script), 'red'], [script_rel], index_tag + '-red', probe_counts,
                  expect_failure=True)
        control = {'result': 'PASS_RED', 'green': green.get('counts'), 'red': red.get('counts')}
        verdict = ('verified' if green.get('verdict') == 'verified' and red.get('verdict') == 'verified'
                   else 'failed' if green.get('verdict') == 'failed' or red.get('verdict') == 'failed'
                   else 'not_measured')
        row = {'arm': arm_name, 'backend': ARM_BACKEND_OF[arm_name], 'verdict': verdict,
               'counts': green.get('counts'), 'control': control, 'green': green, 'red': red}
        real_arm_executions[arm_name] = row
        return row

    for index, suite in enumerate(suites):
        name, members = suite['suite'], suite['members']
        row = {'suite': name, 'members': members, 'executions': []}
        if name == 'maintained-app-e2e':
            # Marker membership stays; exact evidence is the disposable PASS_RED probe.
            probe = run_pass_red_probe('scripts/full-suite-arms/app-e2e.probe.mjs', 'app-e2e',
                                       'root-' + str(index) + '-e2e')
            row['executions'].append(probe['green'])
            row['arm_control'] = probe['control']
            row['verdict'] = probe['verdict']
        elif name == 'maintained-authored-template':
            rendered = render_authored_template(root, scratch, members, env)
            target, config = rendered.pop('target'), rendered.pop('config')
            report = target / 'result.json'
            selected = ['scaffoldprobe.connector.spec.ts']
            result = run(['pnpm', 'exec', 'vitest', 'run', '--config', str(config),
                          '--reporter=json', '--outputFile=' + str(report), *selected],
                         members, 'root-' + str(index),
                         lambda raw: vitest_counts(json.loads(report.read_text()), selected, target))
            for binding in rendered['rendered_files'] + rendered['generated_support']:
                path = Path(binding['path'])
                if (path.is_symlink() or not path.is_file() or
                        hashlib.sha256(path.read_bytes()).hexdigest() != binding['sha256']):
                    result.update(verdict='not_measured', reason='rendered execution source changed')
            result['template_evidence'] = rendered
            row['executions'].append(result)
            row['verdict'] = result['verdict']
        elif name in ('maintained-vitest', 'maintained-integration'):
            selected = members if name == 'maintained-vitest' else [n for n in members if n in OFFLINE_INTEGRATION]
            live = [n for n in members if n not in selected]
            if live:
                # Live provider/auth/storage matrices remain inventoried but are not parked
                # in arms.not_run; real_* slots emit dedicated PASS_RED probe evidence.
                row['live_optional_members'] = live
            if selected:
                report = scratch / (name + '.json')
                argv = ['pnpm', 'exec', 'vitest', 'run']
                if name == 'maintained-integration':
                    argv += ['--config', 'vitest.integration.config.ts']
                else:
                    # The graph runner can execute on hosts with far more
                    # visible CPUs than the CI container actually receives.
                    # Bound worker fan-out so module-bootstrap suites remain
                    # measurable under the same small-runner resource envelope.
                    argv += ['--maxWorkers=4']
                argv += ['--reporter=json', '--outputFile=' + str(report), *selected]
                row['executions'].append(run(argv, selected, 'root-' + str(index),
                    lambda raw: vitest_counts(json.loads(report.read_text()), selected, root)))
            offline_ok = bool(row['executions']) and all(r['verdict'] == 'verified' for r in row['executions'])
            if name == 'maintained-integration' and not selected:
                offline_ok = True  # offline set may be empty only if membership is all live
            row['verdict'] = ('failed' if any(r['verdict'] == 'failed' for r in row['executions']) else
                              'verified' if offline_ok else 'not_measured')
        elif name == 'maintained-regression':
            for offset, member in enumerate(members):
                argv, kind = root_regression_command(root, member)
                result = run(argv, [member], 'root-' + str(index) + '-' + str(offset),
                             lambda raw, kind=kind: regression_counts(kind, raw))
                row['executions'].append(result)
                if result['verdict'] != 'verified':
                    row['held_members'] = members[offset + 1:]
                    break
            row['verdict'] = ('failed' if any(r['verdict'] == 'failed' for r in row['executions']) else
                              'not_measured' if len(row['executions']) != len(members) or any(r['verdict'] != 'verified' for r in row['executions']) else 'verified')
        else:
            raise Refusal('undeclared root group')
        results.append(row)
    # Every defined real_* arm runs once for the root unit, independent of which
    # integration members are present — never leave them in not_run.
    if 'integration-disposable-store' not in real_arm_executions:
        run_pass_red_probe('scripts/full-suite-arms/disposable-store.probe.mjs',
                           'integration-disposable-store', 'root-store')
    if 'integration-external-provider' not in real_arm_executions:
        run_pass_red_probe('scripts/full-suite-arms/external-provider.probe.mjs',
                           'integration-external-provider', 'root-external')
    if 'app-e2e' not in real_arm_executions:
        run_pass_red_probe('scripts/full-suite-arms/app-e2e.probe.mjs', 'app-e2e', 'root-e2e')
    for row in results:
        row['_real_arm_executions'] = real_arm_executions
    if any(p.get('verdict') != 'verified' for p in real_arm_executions.values()):
        # Surface probe failure on the suite that owns the arm when present.
        for row in results:
            if row['suite'] == 'maintained-app-e2e' and real_arm_executions.get('app-e2e', {}).get('verdict') != 'verified':
                row['verdict'] = real_arm_executions['app-e2e']['verdict']
            if row['suite'] == 'maintained-integration':
                store_v = real_arm_executions.get('integration-disposable-store', {}).get('verdict')
                ext_v = real_arm_executions.get('integration-external-provider', {}).get('verdict')
                if store_v != 'verified' or ext_v != 'verified':
                    row['verdict'] = 'failed' if 'failed' in (store_v, ext_v) else 'not_measured'
    return results


# KCP-0027 arm evidence (FullSuiteArmEvidence/v1). The arm set and each slot are declared in
# .arcana/verify.json deployables["."].full_test_arms; the gate recomputes the verdict from the BASE
# definition, so nothing here is a verdict. Every defined arm must appear in `arms` with exact
# counts; `not_run` stays empty — parking an arm there cannot discharge the Program gate.
ARMS_SCHEMA = 'FullSuiteArmEvidence/v1'
ARM_DEFINITION_PATH = '.arcana/verify.json'
ARM_OF_SUITE = {'maintained-vitest': 'vitest-default',
                'maintained-authored-template': 'authored-template',
                'maintained-regression': 'regression',
                'maintained-integration': 'integration-offline-contracts'}


def sum_counts(rows):
    total = {'passed': 0, 'failed': 0, 'skipped': 0}
    for row in rows:
        counts = row.get('counts')
        if counts is None:
            # Exit-status shell validator: its exit 0 is its whole result contract (one check).
            if row.get('verdict') != 'verified':
                return None
            counts = {'passed': 1, 'failed': 0, 'skipped': 0}
        for key in total:
            total[key] += counts[key]
    return {'total': sum(total.values()), **total}


def load_arm_definition(root):
    raw = subprocess.run(['git', '-C', str(root), 'show', 'HEAD:' + ARM_DEFINITION_PATH],
                         capture_output=True, check=True).stdout
    profile = json.loads(raw)
    entries = ((profile.get('deployables') or {}).get('.') or {}).get('full_test_arms')
    if not isinstance(entries, list) or not entries:
        raise Refusal('missing full_test_arms definition')
    arms = {}
    for entry in entries:
        if (not isinstance(entry, dict) or set(entry) != {'name', 'requires'}
                or not isinstance(entry['name'], str) or not entry['name']
                or entry['name'] in arms):
            raise Refusal('invalid full_test_arms definition')
        arms[entry['name']] = entry['requires']
    return raw, arms


def build_arms(root, results, head):
    raw, defined = load_arm_definition(root)
    collected = {}
    real_map = {}
    for row in results:
        real_map.update(row.get('_real_arm_executions') or {})
        name = row.get('suite')
        if name in ARM_OF_SUITE:
            arm_name = ARM_OF_SUITE[name]
            executions = row.get('executions', [])
            held = row.get('held_members', [])
            counts = None
            if executions and all(e.get('verdict') in ('verified', 'failed') for e in executions):
                counts = sum_counts(executions)
            if name == 'maintained-regression' and held:
                counts = None
            if counts is None:
                raise Refusal('missing exact execution evidence for arm ' + arm_name)
            collected[arm_name] = {
                'name': arm_name, 'backend': 'stub', 'counts': counts, 'head': head,
                'verdict': 'failed' if counts['failed'] else 'passed',
            }
    for arm_name, backend in ARM_BACKEND_OF.items():
        if backend == 'stub':
            continue
        probe = real_map.get(arm_name)
        if not probe or probe.get('verdict') != 'verified' or not probe.get('counts'):
            raise Refusal('missing exact execution evidence for arm ' + arm_name)
        counts = probe['counts']
        if counts.get('skipped') or not counts.get('passed') or counts.get('failed'):
            raise Refusal('arm ' + arm_name + ' green probe is not a clean pass')
        control = probe.get('control') or {}
        if control.get('result') != 'PASS_RED':
            raise Refusal('arm ' + arm_name + ' missing PASS_RED control')
        collected[arm_name] = {
            'name': arm_name, 'backend': backend,
            'counts': {'total': sum(counts[k] for k in ('passed', 'failed', 'skipped')), **counts},
            'head': head, 'control': {'result': 'PASS_RED'},
            'verdict': 'passed',
        }
    missing = sorted(set(defined) - set(collected))
    extra = sorted(set(collected) - set(defined))
    if missing or extra:
        raise Refusal('arm set differs from definition (missing %s, extra %s)' % (missing, extra))
    # Stable order matches the committed definition order.
    arms = [collected[name] for name in defined]
    return {'schema': ARMS_SCHEMA, 'head': head,
            'definition': {'path': ARM_DEFINITION_PATH, 'sha256': hashlib.sha256(raw).hexdigest()},
            'arms': arms, 'not_run': []}


def execution_code(results):
    executions = [r for row in results for r in row.get('executions', [row])]
    return (1 if any(r['verdict'] == 'failed' for r in results) else
            124 if any(r.get('exit_code') == 124 for r in executions) else
            127 if any(r['verdict'] == 'not_measured' for r in results) else 0)


def main():
    if len(sys.argv) != 2:
        raise Refusal('exactly one deployable required')
    unit = sys.argv[1]
    check_context(ROOT, unit, Path.cwd())
    rows = inventory(ROOT)
    members = members_for(rows, unit)
    suites = plan(unit, members)
    temp_value = os.environ.get('TMPDIR')
    if not temp_value:
        raise Refusal('owned private TMPDIR required')
    temp = Path(temp_value)
    info = temp.lstat()
    if (temp.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise Refusal('owned private TMPDIR required')
    scratch = Path(tempfile.mkdtemp(prefix='mc-full-' + unit.replace('/', '-') + '-', dir=temp))
    os.chmod(scratch, 0o700)
    head = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'],
                          capture_output=True, check=True).stdout.decode().strip()
    document = {'schema': 'MaintainedFullSuiteExecution/v1', 'head': head, 'unit': unit,
                'membership': rows, 'suite_plan': suites, 'results': [],
                'runtime_authorized': False, 'knowledge_admitted': False}
    try:
        document['results'] = (run_root_suites(ROOT, suites, scratch) if unit == '.' else
                               run_suites(ROOT, unit, suites, scratch))
    except (Refusal, ValueError, KeyError, OSError):
        document['remaining'] = ['invalid or absent execution evidence; inspect private raw suite files']
        code = 1
    else:
        code = execution_code(document['results'])
        if unit == '.':
            try:
                document['arms'] = build_arms(ROOT, document['results'], head)
            except (Refusal, OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
                document['arms_refused'] = str(error)[:200]
                # Missing arm evidence is never a green exit — prefer semantic 127.
                if code == 0 or code == 1:
                    code = 127
    document['exit_code'] = code
    target = scratch / 'execution.json'
    with target.open('x') as stream:
        json.dump(document, stream, indent=2)
        stream.write('\n')
    target.chmod(0o600)
    print('Full-suite evidence:', target)
    for row in document['results']:
        counts = row.get('counts')
        if counts:
            print(row['suite'], ':', counts['passed'], 'passed,', counts['failed'],
                  'failed,', counts['skipped'], 'skipped; raw exit', row.get('exit_code'))
    if code == 127:
        print('FULL_FALLBACK_TEST_NOT_MEASURED: complete maintained obligations not executed')
    return code


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Refusal, OSError, ValueError, subprocess.CalledProcessError):
        print('FULL_FALLBACK_TEST_REFUSED: invalid source/path/environment', file=sys.stderr)
        sys.exit(1)
