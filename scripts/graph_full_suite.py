"""Maintain complete source membership and honest per-suite results, without grants.

Root's real external arms, disposable-store authority and skipped app E2E remain
unmeasured. No environment flag changes that disposition. The other declarations
exercise their complete existing offline/owned-loopback contracts, not production.
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


def clean_environment(scratch, unit_root):
    # No inherited tokens, flags, URLs, NODE_OPTIONS, PYTHONPATH or agent hooks.
    env = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(scratch / 'home'),
           'TMPDIR': str(scratch), 'CI': '1', 'NO_COLOR': '1', 'FORCE_COLOR': '0',
           'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': str(unit_root),
           'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1'}
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
    if member.endswith('.test.mjs'):
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
    env = clean_environment(scratch, root)
    deadline = time.monotonic() + 900
    results = []
    def run(argv, members, name, parser):
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
        if not code:
            try:
                counts = parser(raw)
            except (Refusal, ValueError, KeyError, OSError):
                result.update(verdict='not_measured', reason='missing or invalid exact execution evidence')
            else:
                result['counts'] = counts
                if counts and (counts['failed'] or counts['skipped'] or not counts['passed']):
                    result['verdict'] = 'failed' if counts['failed'] else 'not_measured'
        return result
    for index, suite in enumerate(suites):
        name, members = suite['suite'], suite['members']
        row = {'suite': name, 'members': members, 'executions': []}
        if name == 'maintained-app-e2e':
            row.update(verdict='not_measured', reason='unconditional AppE2E skip; no execution grant',
                       held_members=members)
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
            held = [n for n in members if n not in selected]
            if held:
                row.update(held_members=held, reason='real provider/auth/storage arms or disposable DB/Redis authority unresolved')
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
            row['verdict'] = ('failed' if any(r['verdict'] == 'failed' for r in row['executions']) else
                              'not_measured' if held or not row['executions'] or any(r['verdict'] != 'verified' for r in row['executions']) else 'verified')
        elif name == 'maintained-regression':
            for offset, member in enumerate(members):
                argv, kind = root_regression_command(root, member)
                result = run(argv, [member], 'root-' + str(index) + '-' + str(offset),
                             lambda raw: regression_counts(kind, raw))
                row['executions'].append(result)
                if result['verdict'] != 'verified':
                    row['held_members'] = members[offset + 1:]
                    break
            row['verdict'] = ('failed' if any(r['verdict'] == 'failed' for r in row['executions']) else
                              'not_measured' if len(row['executions']) != len(members) or any(r['verdict'] != 'verified' for r in row['executions']) else 'verified')
        else:
            raise Refusal('undeclared root group')
        results.append(row)
    return results


# Opt-in per-arm evidence (KCP-0027, DEC-AUP-0169/0170). Absent the two variables nothing below runs.
ARM_EVIDENCE_ENV = 'GRAPH_FULL_SUITE_ARM_EVIDENCE'   # os.pathsep-separated retained executor result files
ARM_BASE_ENV = 'GRAPH_FULL_SUITE_ARM_BASE'           # BASE commit whose .arcana/verify.json defines the arms
ARM_DEFINITION_PATH = '.arcana/verify.json'
ARM_REQUIRES = ('real_disposable', 'real_external', 'stub_ok')
# DEC-AUP-0170 item 5: a spec may return early when its gate variable is unset and still count as passed.
# An arm counts only if the executor names every gate variable as set (names only, never values).
ARM_ENV_GATES = {
    'openai-images': ('OPENAI_INTEGRATION',), 'fal-ai': ('FAL_AI_INTEGRATION',),
    'vertex-image': ('VERTEX_BILLING_ENABLED',), 'vertex-auth': ('VERTEX_SERVICE_ACCOUNT_JSON',),
    'image-router-fallback': ('RUN_INTEGRATION', 'VERTEX_SERVICE_ACCOUNT_JSON'),
    'image-generation-e2e': ('MODEL_CONNECTOR_API_KEY', 'VERTEX_SERVICE_ACCOUNT_JSON'),
    'app-e2e': ('DEEPSEEK_API_KEY',),
}


def arm_backend(label):
    text = json.dumps(label) if not isinstance(label, str) else label
    low = text.lower()
    if low.startswith('stub'):
        return 'stub'
    if 'external' in low and low.startswith('real'):
        return 'real_external'
    if low.startswith('real') and 'disposable' in low:
        return 'real_disposable'
    return 'none'


def arm_candidates(document):
    """Map one retained KCP0027ArmExecution/v1* file to [{name, ...}] without judging it."""
    head = document.get('worktree_head')
    out = []
    if isinstance(document.get('arms'), dict):                      # A, A2: several arms
        for name, row in sorted(document['arms'].items()):
            control = row.get('connectivity_control') or row.get('mutation_control') or {}
            out.append({'name': name, 'head': head, 'exit': row.get('exit'), 'counts': row.get('counts'),
                        'backend': arm_backend(row.get('backend') or document.get('backend')),
                        'control': control.get('result'),
                        'env': set(row.get('env_keys_set') or document.get('env_keys_set') or [])})
    elif isinstance(document.get('arm'), str) and isinstance(document.get('run'), dict):   # A3, A4: one arm
        controls = document.get('controls')
        results = [c.get('result') for c in controls.values() if isinstance(c, dict)] if isinstance(controls, dict) else []
        out.append({'name': document['arm'], 'head': head, 'exit': document['run'].get('exit'),
                    'counts': document['run'].get('counts'), 'backend': arm_backend(document.get('backend')),
                    'control': 'PASS_RED' if results and all(r == 'PASS_RED' for r in results) else None,
                    'env': set(document.get('env_keys_set') or [])})
    return out


def arm_clean_counts(counts):
    keys = ('total', 'passed', 'failed', 'skipped')
    if not isinstance(counts, dict) or set(counts) != set(keys):
        return None
    if any(not isinstance(counts[k], int) or isinstance(counts[k], bool) or counts[k] < 0 for k in keys):
        return None
    return {k: counts[k] for k in keys}


def arm_evidence(root, head, environ):
    """FullSuiteArmEvidence/v1 from retained executor results, or None when not opted in.

    Never synthesizes a pass: every defined arm without clean, head-bound, gate-proven input is listed in
    `not_run`. The surrounding row stays whatever the suite itself earned."""
    paths = environ.get(ARM_EVIDENCE_ENV)
    if not paths:
        return None
    notes = []
    base = environ.get(ARM_BASE_ENV, '')
    if len(base) != 40 or any(c not in '0123456789abcdef' for c in base):
        return {'refused': 'arm evidence needs ' + ARM_BASE_ENV + ' (40-hex BASE commit)'}
    shown = subprocess.run(['git', '-C', str(root), 'show', base + ':' + ARM_DEFINITION_PATH], capture_output=True)
    if shown.returncode:
        return {'refused': 'BASE has no ' + ARM_DEFINITION_PATH}
    raw = shown.stdout
    try:
        entries = json.loads(raw)['deployables']['.']['full_test_arms']
        defined = {}
        for e in entries:
            if set(e) != {'name', 'requires'} or e['requires'] not in ARM_REQUIRES or e['name'] in defined:
                raise ValueError
            defined[e['name']] = e['requires']
        if not defined:
            raise ValueError
    except (ValueError, KeyError, TypeError):
        return {'refused': 'BASE full_test_arms is missing or invalid'}
    seen = {}
    for text in paths.split(os.pathsep):
        try:
            path = Path(text)
            if not path.is_absolute() or path.is_symlink():
                raise ValueError
            found = arm_candidates(json.loads(path.read_text()))
        except (ValueError, OSError, AttributeError):
            notes.append('unreadable or unsupported evidence file')
            continue
        for cand in found:
            seen.setdefault(cand['name'], []).append(cand)
    arms, not_run = [], []
    for name in defined:
        cands = seen.get(name, [])
        why = None
        if len(cands) != 1:
            why = 'no evidence' if not cands else 'duplicate evidence'
        else:
            cand = cands[0]
            counts = arm_clean_counts(cand['counts'])
            gates = ARM_ENV_GATES.get(name, ())
            if cand['head'] != head:
                why = 'evidence head differs from HEAD'
            elif counts is None:
                why = 'counts malformed'
            elif set(gates) - cand['env']:
                why = 'gate variables not named as set: ' + ','.join(sorted(set(gates) - cand['env']))
        if why:
            not_run.append(name)
            notes.append(name + ': ' + why)
            continue
        cand = cands[0]
        counts = arm_clean_counts(cand['counts'])
        ok = (cand['exit'] == 0 and counts['total'] > 0 and counts['passed'] == counts['total']
              and (cand['control'] == 'PASS_RED' or cand['backend'] == 'stub'))
        arm = {'name': name, 'backend': cand['backend'], 'counts': counts, 'head': head,
               'verdict': 'failed' if counts['failed'] else 'verified' if ok else 'not_measured'}
        if cand['control']:
            arm['control'] = {'result': cand['control']}
        arms.append(arm)
    for name in sorted(set(seen) - set(defined)):
        notes.append(name + ': not a defined arm, ignored')
    return {'schema': 'FullSuiteArmEvidence/v1', 'head': head,
            'definition': {'path': ARM_DEFINITION_PATH, 'sha256': hashlib.sha256(raw).hexdigest()},
            'arms': arms, 'not_run': not_run, 'notes': notes}


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
    if unit == '.':
        document['remaining'] = ['seven real external provider/auth/storage/image arms',
                                 'unconditional AppE2E skip',
                                 'broader disposable DB/Redis executor and namespace authority']
    try:
        document['results'] = (run_root_suites(ROOT, suites, scratch) if unit == '.' else
                               run_suites(ROOT, unit, suites, scratch))
    except (Refusal, ValueError, KeyError, OSError):
        document['remaining'] = ['invalid or absent execution evidence; inspect private raw suite files']
        code = 1
    else:
        code = execution_code(document['results'])
    if unit == '.' and os.environ.get(ARM_EVIDENCE_ENV):
        emitted = arm_evidence(ROOT, head, os.environ)
        if emitted and emitted.get('refused'):
            document['arms_refused'] = emitted['refused']
        elif emitted:
            document['arms_notes'] = emitted.pop('notes')
            document['arms'] = emitted
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
