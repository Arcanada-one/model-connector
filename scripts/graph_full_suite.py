"""Maintain complete source membership and honest per-suite results.

Without an owned FullSuiteDisposableGrant/v1, real disposable-store authority,
app E2E and live external provider arms remain unmeasured. Ambient environment
flags never lift that disposition. A grant file (mode 0600, under the private
runner temp) may authorize disposable Postgres/Redis + Nest app-e2e only.
Live-credential image-generation members stay held_live_opt_in until a later
local-stub range; they are never silently dropped from membership.
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
NODE_TAP_SPEC_MEMBERS = frozenset({
    'provider-profiles/fi10-persona-resolve.spec.mjs',
})

UNITS = ('.', 'packages/sdk-python', 'packages/sdk-ts', 'watcher')
ROOT = Path(__file__).resolve().parents[1]
ENV_FILES = ('.env', '.env.local', '.env.integration', '.env.test')
# Reviewed existing fake-connector/MSW contracts, never a provider/storage grant.
OFFLINE_INTEGRATION = frozenset({
    'src/connectors/cascade/cascade-router.fallback.integration.spec.ts',
    'src/openai-compat/openai-compat.failover.integration.spec.ts',
    'src/speech/stt/stt-pilot.integration.spec.ts',
})
GRANT_SCHEMA = 'FullSuiteDisposableGrant/v1'
GRANT_ENV_KEY = 'MC_FULL_SUITE_GRANT'
GRANT_ARM_DISPOSABLE = 'integration-disposable-store'
GRANT_ARM_APP_E2E = 'app-e2e'
# Env keys a disposable grant may inject into child processes (never secrets).
GRANT_ENV_ALLOWLIST = frozenset({
    'DATABASE_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PREFIX', 'REDIS_PASSWORD',
    'STT_PROVIDER_GROQ_ENABLED', 'STT_GROQ_API_KEY', 'NODE_ENV', 'PORT', 'HOST',
    'MC_FULL_SUITE_APP_E2E',
    'BENCH_OWNED_TEST_PG_SOCKET', 'BENCH_OWNED_TEST_SOCKET_ROOT',
    'BENCH_OWNED_NATIVE_TEST_BINARY',
})
# Log tails printed on failure (job log only; never Actions artifact).
FAIL_LOG_TAIL_LINES = 80
_SECRET_TAIL_RE = re.compile(
    r'((?:postgres(?:ql)?|redis|mysql|mongodb)://[^:\s/]+:)([^@\s/]+)(@)'
    r'|((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)(\S+)',
    re.IGNORECASE,
)
BENCH_OWNED_MEMBER = 'src/bench-reservation/postgres.integration.spec.ts'
HELD_STORE_PREFIXES = ('src/auth/', 'src/bench-reservation/', 'src/billing/')
HELD_PROVIDER_PREFIXES = ('src/connectors/image-generation/',)


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
            elif name in NODE_TAP_SPEC_MEMBERS:
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


def _private_temp_roots():
    roots = []
    for key in ('XDG_RUNTIME_DIR', 'RUNNER_TEMP'):
        value = os.environ.get(key)
        if value:
            roots.append(Path(value).resolve())
    return roots


def load_disposable_grant():
    """Load an owned FullSuiteDisposableGrant/v1, or None when absent.

    Ambient CI=1 / DATABASE_URL alone never grants. The path must be absolute,
    mode 0600, uid-owned, not a symlink, and under XDG_RUNTIME_DIR or RUNNER_TEMP.
    """
    raw_path = os.environ.get(GRANT_ENV_KEY)
    if not raw_path:
        return None
    path = Path(raw_path)
    if not path.is_absolute():
        raise Refusal('full-suite grant path must be absolute')
    try:
        info = path.lstat()
    except OSError as exc:
        raise Refusal('full-suite grant unreadable') from exc
    if path.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise Refusal('full-suite grant must be a regular non-symlink file')
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise Refusal('full-suite grant must be mode 0600 and owned by the caller')
    resolved = path.resolve()
    if not any(resolved == root or root in resolved.parents for root in _private_temp_roots()):
        raise Refusal('full-suite grant must live under XDG_RUNTIME_DIR or RUNNER_TEMP')
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise Refusal('full-suite grant is not valid JSON') from exc
    if not isinstance(doc, dict) or doc.get('schema') != GRANT_SCHEMA:
        raise Refusal('full-suite grant schema mismatch')
    arms = doc.get('arms')
    env = doc.get('env')
    if not isinstance(arms, list) or not arms or not all(isinstance(a, str) for a in arms):
        raise Refusal('full-suite grant arms malformed')
    if not isinstance(env, dict) or not env:
        raise Refusal('full-suite grant env malformed')
    unknown = set(env) - GRANT_ENV_ALLOWLIST
    if unknown:
        raise Refusal('full-suite grant env has disallowed keys: ' + ', '.join(sorted(unknown)))
    for key, value in env.items():
        if not isinstance(value, str) or not value:
            raise Refusal('full-suite grant env values must be non-empty strings')
    allowed = {GRANT_ARM_DISPOSABLE, GRANT_ARM_APP_E2E}
    if set(arms) - allowed:
        raise Refusal('full-suite grant arms out of disposable/app-e2e scope')
    return {'path': str(resolved), 'arms': list(arms), 'env': dict(env),
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def clean_environment(scratch, unit_root, grant=None):
    """Build the base child env. Grant keys are NOT injected here.

    Disposable/e2e children receive grant env only via env_override on those
    steps so maintained-vitest / regression / offline never see DATABASE_URL.
    The unused ``grant`` argument is accepted for call-site compatibility and
    must remain unused.
    """
    del grant  # never ambient-inject; see pass_red_vitest / disposable overrides
    # Isolated env -i strips runner ambient DATABASE_URL that lint-and-test often
    # inherits. Provide a non-grant placeholder so Zod config can parse; nothing
    # here authorizes disposable TCP or Nest app-e2e (those need grant override).
    # HOME stays under the private scratch (never world-writable /tmp). TMPDIR may
    # use MC_FULL_SUITE_SHORT_TMP so unix-socket composition specs stay <108 bytes.
    short_tmp = os.environ.get('MC_FULL_SUITE_SHORT_TMP')
    tmpdir = short_tmp if short_tmp else str(scratch)
    if short_tmp:
        short_path = Path(short_tmp)
        info = short_path.lstat()
        if (short_path.is_symlink() or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise Refusal('MC_FULL_SUITE_SHORT_TMP must be an owned mode-0700 directory')
    env = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(scratch / 'home'),
           'TMPDIR': tmpdir, 'CI': '1', 'NO_COLOR': '1', 'FORCE_COLOR': '0',
           'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': str(unit_root),
           'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
           'NODE_ENV': 'test',
           'DATABASE_URL': 'postgresql://suite:suite@127.0.0.1:65535/suite_placeholder'}
    # Forward pinned Compose CLI discovery (lint-and-test / graph-full-suite job
    # install under DOCKER_CONFIG). Without this, `docker compose -f` becomes
    # `docker -f` on runners that lack a system compose plugin.
    for key in ('DOCKER_CONFIG', 'DOCKER_HOST'):
        value = os.environ.get(key)
        if value:
            env[key] = value
    if any(not Path(part).is_absolute() for part in env['PATH'].split(os.pathsep)):
        raise Refusal('relative PATH entry')
    (scratch / 'home').mkdir(mode=0o700)
    return env


def scrub_log_line(line):
    """Mask credential-bearing URL userinfo and common key=value secrets."""
    def repl(match):
        if match.group(1):
            return match.group(1) + '***' + match.group(3)
        return match.group(4) + '***'
    return _SECRET_TAIL_RE.sub(repl, line)[:500]


def emit_failure_log_tail(raw_log, label, limit=FAIL_LOG_TAIL_LINES):
    """Print a bounded, scrubbed tail of a failing child log to the job stdout."""
    path = Path(raw_log) if raw_log else None
    print('  --- fail log tail:', label, '---')
    if not path or not path.is_file():
        print('  | (log missing)')
        return
    try:
        lines = path.read_text(errors='replace').splitlines()
    except OSError as exc:
        print('  | (log unreadable:', type(exc).__name__ + ')')
        return
    if not lines:
        print('  | (empty)')
        return
    for line in lines[-limit:]:
        print('  |', scrub_log_line(line))


def emit_vitest_json_failures(report_path, limit=12):
    """Print scrubbed failed assertion messages from a Vitest JSON report."""
    path = Path(report_path) if report_path else None
    if not path or not path.is_file():
        return
    try:
        document = json.loads(path.read_text())
    except (OSError, ValueError, UnicodeDecodeError):
        print('  | (vitest json report unreadable)')
        return
    print('  --- vitest json failures:', path.name, '---')
    printed = 0
    for row in document.get('testResults') or []:
        for assertion in row.get('assertionResults') or []:
            if assertion.get('status') != 'failed':
                continue
            name = assertion.get('fullName') or assertion.get('title') or '?'
            file_name = Path(row.get('name', '?')).name
            print('  | FAIL', file_name, '::', scrub_log_line(str(name)))
            for message in (assertion.get('failureMessages') or [])[:1]:
                for line in str(message).splitlines()[:20]:
                    print('  |', scrub_log_line(line))
            printed += 1
            if printed >= limit:
                return
    if printed == 0:
        print('  | (no failed assertions in json; numFailedTests=%s numTotalTests=%s)'
              % (document.get('numFailedTests'), document.get('numTotalTests')))


def disposable_member(path):
    return path.startswith(HELD_STORE_PREFIXES) and path.endswith('.integration.spec.ts')


def external_member(path):
    return path.startswith(HELD_PROVIDER_PREFIXES) and path.endswith('.integration.spec.ts')


def bench_fixture_ready(grant):
    if not grant:
        return False
    env = grant['env']
    socket = env.get('BENCH_OWNED_TEST_PG_SOCKET', '')
    root = env.get('BENCH_OWNED_TEST_SOCKET_ROOT', '')
    binary = env.get('BENCH_OWNED_NATIVE_TEST_BINARY', '')
    return (bool(socket) and '/mc-owned-postgres/socket' in socket
            and bool(root) and bool(binary)
            and '/clean-native-build-v4/target/debug/deps/codex_http_client-' in binary)


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
        # Optional CI venv python (MC_FULL_SUITE_PYTHON) carries jsonschema etc.
        # Keep the venv path as given: resolving the common venv/bin/python symlink
        # lands on system python and drops the venv site-packages.
        python = os.environ.get('MC_FULL_SUITE_PYTHON') or sys.executable
        if python != sys.executable:
            py_path = Path(python)
            if not py_path.exists() or not os.access(python, os.X_OK):
                raise Refusal('MC_FULL_SUITE_PYTHON must be an executable path')
        return [python, '-B', path], 'unittest'
    if member.endswith('.test.mjs') or member in NODE_TAP_SPEC_MEMBERS:
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


def run_root_suites(root, suites, scratch, executor=execute, grant=None):
    """Dispatch ordinary local groups; preserve every held member without spawning it.

    With a disposable grant, Nest app-e2e and TCP Postgres/Redis disposable-store
    members may execute. Live-credential image-generation members and the owned
    bench unix-socket fixture stay held until their prerequisites exist.
    """
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
    grant_env = dict(grant['env']) if grant else {}
    deadline = time.monotonic() + 900
    results = []
    grant_arms = set(grant['arms']) if grant else set()

    def run(argv, members, name, parser, env_override=None):
        child_env = dict(env)
        if env_override:
            child_env.update(env_override)
        required = [argv[0]]
        if members == ['deploy/compose-network.test.sh']:
            required.append('docker')  # Compose config only, never start or stop.
        missing = [tool for tool in required if not shutil.which(tool, path=child_env['PATH'])]
        if argv[0] == 'pnpm' and not (root / 'node_modules/.bin/vitest').is_file():
            missing.append('owned Vitest dependency')
        if missing:
            return {'argv': argv, 'members': members, 'verdict': 'not_measured',
                    'exit_code': 127, 'reason': 'missing local runner: ' + ', '.join(missing)}
        result = executor(argv, root, child_env, deadline, scratch, name)
        raw = result.pop('output')
        code = result['exit_code']
        result.update(members=members, raw_log=str(scratch / (name + '.log')),
                      verdict='not_measured' if code in (124, 127) else 'failed' if code else 'verified')
        if not code:
            try:
                counts = parser(raw)
            except (Refusal, ValueError, KeyError, OSError, TypeError) as exc:
                detail = str(exc).strip() or type(exc).__name__
                result.update(verdict='not_measured',
                              reason='missing or invalid exact execution evidence: ' + detail[:160])
            else:
                result['counts'] = counts
                if counts and (counts['failed'] or counts['skipped'] or not counts['passed']):
                    result['verdict'] = 'failed' if counts['failed'] else 'not_measured'
        return result

    def pass_red_vitest(config_args, selected, label, report_path):
        """Broken DATABASE_URL must fail before the real disposable/e2e run.

        Grant env is applied only here (and the real follow-up), never to the
        shared base env used by vitest-default / regression / offline.
        """
        if not grant_env:
            raise Refusal('PASS_RED disposable/e2e requires grant env')
        red_report = scratch / (label + '-pass-red.json')
        red_argv = ['pnpm', 'exec', 'vitest', 'run', *config_args,
                    '--reporter=default', '--reporter=json',
                    '--outputFile=' + str(red_report), *selected]
        red_env = dict(grant_env)
        red_env['DATABASE_URL'] = 'postgresql://pass-red:pass-red@127.0.0.1:1/pass_red'
        red = run(red_argv, selected, label + '-pass-red',
                  lambda raw: vitest_counts(json.loads(red_report.read_text()), selected, root),
                  env_override=red_env)
        red['vitest_report'] = str(red_report)
        if red.get('verdict') == 'verified':
            red.update(verdict='failed', reason='PASS_RED control unexpectedly verified')
            return red, None
        red['control'] = {'result': 'PASS_RED'}
        real_argv = ['pnpm', 'exec', 'vitest', 'run', *config_args,
                     '--reporter=default', '--reporter=json',
                     '--outputFile=' + str(report_path), *selected]
        real = run(real_argv, selected, label,
                   lambda raw: vitest_counts(json.loads(report_path.read_text()), selected, root),
                   env_override=grant_env)
        real['vitest_report'] = str(report_path)
        real['control'] = {'result': 'PASS_RED'}
        return red, real

    for index, suite in enumerate(suites):
        name, members = suite['suite'], suite['members']
        row = {'suite': name, 'members': members, 'executions': []}
        if name == 'maintained-app-e2e':
            if (GRANT_ARM_APP_E2E in grant_arms
                    and grant_env.get('MC_FULL_SUITE_APP_E2E') == '1'):
                report = scratch / 'maintained-app-e2e.json'
                red, real = pass_red_vitest(
                    ['--config', 'vitest.e2e.config.ts'], members,
                    'root-' + str(index), report)
                row['executions'].extend([red] + ([real] if real else []))
                # PASS_RED control is intentionally failed; suite verdict uses real run only.
                real_only = _real_executions(row['executions'])
                row['verdict'] = (
                    'failed' if any(r['verdict'] == 'failed' for r in real_only) else
                    'not_measured' if (not real_only or any(r['verdict'] != 'verified' for r in real_only))
                    else 'verified')
                row['arm'] = 'app-e2e'
            else:
                row.update(verdict='not_measured', reason='AppE2E held; no disposable grant',
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
        elif name == 'maintained-vitest':
            selected, held = members, []
            report = scratch / (name + '.json')
            argv = ['pnpm', 'exec', 'vitest', 'run', '--maxWorkers=4',
                    '--reporter=default', '--reporter=json',
                    '--outputFile=' + str(report), *selected]
            result = run(argv, selected, 'root-' + str(index),
                lambda raw: vitest_counts(json.loads(report.read_text()), selected, root))
            result['vitest_report'] = str(report)
            row['executions'].append(result)
            row['verdict'] = ('failed' if any(r['verdict'] == 'failed' for r in row['executions']) else
                              'not_measured' if not row['executions'] or any(r['verdict'] != 'verified' for r in row['executions']) else 'verified')
        elif name == 'maintained-integration':
            offline = [n for n in members if n in OFFLINE_INTEGRATION]
            disposable = [n for n in members if disposable_member(n)]
            external = [n for n in members if external_member(n)]
            other = [n for n in members if n not in offline and n not in disposable and n not in external]
            if other:
                raise Refusal('unclassified integration member: ' + ', '.join(other))
            held_reasons = {}
            run_disposable = []
            held_disposable = []
            if GRANT_ARM_DISPOSABLE in grant_arms:
                for path_name in disposable:
                    if path_name == BENCH_OWNED_MEMBER and not bench_fixture_ready(grant):
                        held_disposable.append(path_name)
                        held_reasons[path_name] = (
                            'held_owned_bench_fixture: unix-socket postgres + native UNIT TEST binary required')
                    else:
                        run_disposable.append(path_name)
            else:
                held_disposable = list(disposable)
                for path_name in disposable:
                    held_reasons[path_name] = 'held_disposable: no FullSuiteDisposableGrant/v1'
            for path_name in external:
                held_reasons[path_name] = (
                    'held_live_opt_in: live provider credentials/money; local stub range later')
            held = held_disposable + external
            if offline:
                report = scratch / (name + '-offline.json')
                argv = ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
                        '--reporter=default', '--reporter=json',
                        '--outputFile=' + str(report), *offline]
                result = run(argv, offline, 'root-' + str(index) + '-offline',
                    lambda raw, selected=offline, report=report: vitest_counts(
                        json.loads(report.read_text()), selected, root))
                result['vitest_report'] = str(report)
                row['executions'].append(result)
            if run_disposable:
                report = scratch / (name + '-disposable.json')
                red, real = pass_red_vitest(
                    ['--config', 'vitest.integration.config.ts'], run_disposable,
                    'root-' + str(index) + '-disposable', report)
                row['executions'].extend([red] + ([real] if real else []))
                row['disposable_members'] = run_disposable
                row['disposable_arm'] = GRANT_ARM_DISPOSABLE
            if held:
                row.update(held_members=held, held_reasons=held_reasons,
                           reason='held members retained visibly (live-opt-in and/or owned bench fixture)')
            real_execs = [r for r in row['executions']
                          if 'pass-red' not in Path(r.get('raw_log', 'x')).name]
            # Held members keep the suite not_measured even when offline/disposable green.
            if any(r['verdict'] == 'failed' for r in real_execs):
                row['verdict'] = 'failed'
            elif held or not real_execs or any(r['verdict'] != 'verified' for r in real_execs):
                row['verdict'] = 'not_measured'
            else:
                row['verdict'] = 'verified'
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


# KCP-0027 arm evidence (FullSuiteArmEvidence/v1). The arm set and each slot are declared in
# .arcana/verify.json deployables["."].full_test_arms; the gate recomputes the verdict from the BASE
# definition, so nothing here is a verdict. Only arms that actually executed carry counts. Held arms
# (real disposable stores, real providers, the unconditional AppE2E skip) are listed in `not_run`
# and keep the whole root suite not_measured. No environment flag changes that disposition.
ARMS_SCHEMA = 'FullSuiteArmEvidence/v1'
ARM_DEFINITION_PATH = '.arcana/verify.json'
ARM_OF_SUITE = {'maintained-vitest': 'vitest-default',
                'maintained-authored-template': 'authored-template',
                'maintained-regression': 'regression'}


def classify_held(member):
    if member.endswith('.e2e-spec.ts'):
        return 'app-e2e'
    if member.startswith(HELD_STORE_PREFIXES):
        return 'integration-disposable-store'
    if member.startswith(HELD_PROVIDER_PREFIXES):
        return 'integration-external-provider'
    raise Refusal('unclassified held member: new held members must be assigned to an arm')


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


def _real_executions(executions):
    return [e for e in executions if 'pass-red' not in Path(e.get('raw_log', 'x')).name]


def build_arms(root, results, head):
    raw = subprocess.run(['git', '-C', str(root), 'show', 'HEAD:' + ARM_DEFINITION_PATH],
                         capture_output=True, check=True).stdout
    arms, ran, not_run = [], set(), set()
    for row in results:
        name = row['suite']
        executions = row.get('executions', [])
        held = row.get('held_members', [])
        if name == 'maintained-app-e2e':
            real = _real_executions(executions)
            if (row.get('arm') == 'app-e2e' and real and all(e.get('verdict') == 'verified' for e in real)
                    and all(e.get('control', {}).get('result') == 'PASS_RED' for e in real)):
                counts = sum_counts(real)
                if counts is not None:
                    arms.append({'name': 'app-e2e', 'backend': 'real_disposable', 'counts': counts,
                                 'head': head, 'control': {'result': 'PASS_RED'},
                                 'verdict': 'failed' if counts['failed'] else 'passed'})
                    ran.add('app-e2e')
                    continue
            not_run.add('app-e2e')
            continue
        if name == 'maintained-integration':
            not_run.update(classify_held(m) for m in held)
            offline_execs = [e for e in _real_executions(executions)
                             if 'disposable' not in Path(e.get('raw_log', 'x')).name]
            disposable_execs = [e for e in _real_executions(executions)
                                if 'disposable' in Path(e.get('raw_log', 'x')).name]
            if offline_execs and all(e.get('verdict') in ('verified', 'failed') for e in offline_execs):
                counts = sum_counts(offline_execs)
                if counts is not None:
                    arms.append({'name': 'integration-offline-contracts', 'backend': 'stub',
                                 'counts': counts, 'head': head,
                                 'verdict': 'failed' if counts['failed'] else 'passed'})
                    ran.add('integration-offline-contracts')
                else:
                    not_run.add('integration-offline-contracts')
            else:
                not_run.add('integration-offline-contracts')
            # Disposable arm only when every disposable member ran (none held in that class).
            disposable_held = [m for m in held if disposable_member(m)]
            if (not disposable_held and disposable_execs
                    and all(e.get('verdict') == 'verified' for e in disposable_execs)
                    and all(e.get('control', {}).get('result') == 'PASS_RED' for e in disposable_execs)):
                counts = sum_counts(disposable_execs)
                if counts is not None:
                    arms.append({'name': 'integration-disposable-store', 'backend': 'real_disposable',
                                 'counts': counts, 'head': head, 'control': {'result': 'PASS_RED'},
                                 'verdict': 'failed' if counts['failed'] else 'passed'})
                    ran.add('integration-disposable-store')
            elif 'integration-disposable-store' not in not_run:
                not_run.add('integration-disposable-store')
            continue
        arm_name = ARM_OF_SUITE[name]
        counts = None
        if executions and all(e.get('verdict') in ('verified', 'failed') for e in executions):
            counts = sum_counts(executions)
        if name == 'maintained-regression' and held:
            counts = None  # an unexecuted regression suffix keeps the arm unmeasured
        if counts is None:
            not_run.add(arm_name)
            continue
        arms.append({'name': arm_name, 'backend': 'stub', 'counts': counts, 'head': head,
                     'verdict': 'failed' if counts['failed'] else 'passed'})
        ran.add(arm_name)
    return {'schema': ARMS_SCHEMA, 'head': head,
            'definition': {'path': ARM_DEFINITION_PATH, 'sha256': hashlib.sha256(raw).hexdigest()},
            'arms': arms, 'not_run': sorted(not_run - ran)}


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
    grant = load_disposable_grant() if unit == '.' else None
    document = {'schema': 'MaintainedFullSuiteExecution/v1', 'head': head, 'unit': unit,
                'membership': rows, 'suite_plan': suites, 'results': [],
                'runtime_authorized': False, 'knowledge_admitted': False}
    if grant:
        document['disposable_grant'] = {
            'schema': GRANT_SCHEMA, 'path': grant['path'], 'sha256': grant['sha256'],
            'arms': grant['arms']}
    if unit == '.':
        document['remaining'] = [
            'held_live_opt_in: live image-generation provider credentials/money',
            'held_owned_bench_fixture unless grant supplies unix-socket postgres + native binary',
            'app-e2e / disposable-store require FullSuiteDisposableGrant/v1',
        ]
    try:
        document['results'] = (run_root_suites(ROOT, suites, scratch, grant=grant) if unit == '.' else
                               run_suites(ROOT, unit, suites, scratch))
    except (Refusal, ValueError, KeyError, OSError):
        document['remaining'] = ['invalid or absent execution evidence; inspect private raw suite files']
        code = 1
    else:
        code = execution_code(document['results'])
        if unit == '.':
            try:
                document['arms'] = build_arms(ROOT, document['results'], head)
            except (Refusal, OSError, subprocess.CalledProcessError) as error:
                document['arms_refused'] = str(error)[:200]
    document['exit_code'] = code
    target = scratch / 'execution.json'
    with target.open('x') as stream:
        json.dump(document, stream, indent=2)
        stream.write('\n')
    target.chmod(0o600)
    print('Full-suite evidence:', target)
    for row in document['results']:
        held_n = len(row.get('held_members') or [])
        print(row['suite'], 'verdict=' + str(row.get('verdict')),
              'held_members=' + str(held_n),
              'executions=' + str(len(row.get('executions') or [])))
        for ex in row.get('executions') or []:
            log_name = Path(ex.get('raw_log', 'x')).name
            counts = ex.get('counts')
            if counts:
                print(' ', log_name + ':',
                      counts['passed'], 'passed,', counts['failed'],
                      'failed,', counts['skipped'], 'skipped; raw exit',
                      ex.get('exit_code'), 'verdict=' + str(ex.get('verdict')))
            else:
                print(' ', log_name + ':',
                      'verdict=' + str(ex.get('verdict')),
                      'exit=' + str(ex.get('exit_code')),
                      'reason=' + str(ex.get('reason', ''))[:160])
            # PASS_RED control failures are expected; print tails for other fails
            # and for not_measured evidence gaps (Root: job log, not Actions artifacts).
            if 'pass-red' in log_name:
                continue
            if ex.get('verdict') == 'failed':
                emit_failure_log_tail(ex.get('raw_log'), log_name)
                if ex.get('vitest_report'):
                    emit_vitest_json_failures(ex['vitest_report'])
            elif ex.get('verdict') == 'not_measured':
                emit_failure_log_tail(ex.get('raw_log'), log_name)
                if ex.get('vitest_report'):
                    emit_vitest_json_failures(ex['vitest_report'])
        reasons = row.get('held_reasons') or {}
        for path_name, reason in sorted(reasons.items()):
            print('  held:', path_name, '->', reason)
    if code == 127:
        print('FULL_FALLBACK_TEST_NOT_MEASURED: complete maintained obligations not executed')
    return code


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Refusal, OSError, ValueError, subprocess.CalledProcessError):
        print('FULL_FALLBACK_TEST_REFUSED: invalid source/path/environment', file=sys.stderr)
        sys.exit(1)
