"""Maintain complete source membership and honest per-suite results, without grants.

Root's database, Redis and app E2E arms run against stores this process creates
itself (scripts/owned_stores.py: private data directory, kernel-chosen endpoints,
torn down in ``finally``), never a shared or production store. Arms that need a live
external service stay not_measured and are listed with a precise class in
``EXTERNAL_ARMS``; no environment flag changes that disposition. The other
declarations exercise their complete existing offline/owned-loopback contracts.
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
import tarfile
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from owned_stores import OwnedPostgres, OwnedRedis, StoreUnavailable  # noqa: E402

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
# Offline, in-process: needs only the spec's own RUN_INTEGRATION=1 switch; no network and no
# credential is read. Its single credential-conditional test returns early without one, so
# the row carries that fact in `credential_conditional_tests` instead of hiding it.
OFFLINE_RUN_FLAG = {
    'src/connectors/image-generation/image-router.fallback.integration.spec.ts':
        ['VertexImageConnector with real SA JSON passes placeholder check (is NOT placeholder)'],
}
# Reviewed specs that need only a disposable PostgreSQL and/or Redis owned by the run.
OWNED_STORE_INTEGRATION = frozenset({
    'src/auth/rate-limit.integration.spec.ts',
    'src/billing/billing.integration.spec.ts',
    'src/billing/gift.integration.spec.ts',
    'src/billing/hold.integration.spec.ts',
    'src/billing/idempotency.integration.spec.ts',
    'src/billing/metering.integration.spec.ts',
    'src/billing/payment.integration.spec.ts',
    'src/billing/reconciler.integration.spec.ts',
})
# Disposable stores plus a seeded API key; the spec makes no provider call without credentials.
OWNED_STORE_SEEDED_KEY = frozenset({
    'src/connectors/image-generation/image-generation.e2e.integration.spec.ts',
})
# Arms that cannot be measured by this process, each with the measured reason.
# 'live_external_service': the assertion is about a real third-party service and needs
#     its credential; 'native_binary': needs an externally built native test binary.
EXTERNAL_ARMS = {
    'src/connectors/image-generation/vertex/vertex-auth.service.integration.spec.ts':
        ('live_external_service', ['VERTEX_SERVICE_ACCOUNT_JSON', 'RUN_INTEGRATION']),
    'src/connectors/image-generation/vertex/vertex-image.connector.integration.spec.ts':
        ('live_external_service', ['VERTEX_SERVICE_ACCOUNT_JSON', 'VERTEX_BILLING_ENABLED', 'RUN_INTEGRATION']),
    'src/connectors/image-generation/fal-ai/fal-ai.connector.integration.spec.ts':
        ('live_external_service', ['FAL_AI_API_KEY', 'FAL_AI_INTEGRATION', 'RUN_INTEGRATION']),
    'src/connectors/image-generation/openai-images/openai-images.connector.integration.spec.ts':
        ('live_external_service', ['OPENAI_API_KEY', 'OPENAI_INTEGRATION', 'RUN_INTEGRATION']),
    'src/bench-reservation/postgres.integration.spec.ts':
        ('native_binary', ['BENCH_OWNED_NATIVE_TEST_BINARY', 'BENCH_OWNED_TEST_SOCKET_ROOT']),
}
# Tests inside an executed file that skip by design when an external source is absent.
# The snapshot is committed as a sha256-pinned archive (see PINNED_BILLING_SOURCE), so the skip
# only survives when that archive is missing from the tree being measured.
EXTERNAL_SKIPS = {
    'src/bench-reservation/journal-bridge.spec.ts':
        ('external_source_snapshot', ['BILLING_CUSTODIAN_SOURCE'],
         '4 tests need the reviewed Billing3a source snapshot from another repository'),
}
PINNED_BILLING_SOURCE = 'test/fixtures/billing-3a-source.lineage.json'
BILLING_MODULE_PINS = 'test/fixtures/billing-3a-module-pins.json'
# Held files that still carry measurable tests: name filter that leaves out only the native-binary tests.
BENCH_PARTIAL = {'src/bench-reservation/postgres.integration.spec.ts': '^(?!.*native)'}
# The one arm that a local S3-compatible stub measures at the contract level.
STUB_STORAGE_INTEGRATION = frozenset({'src/connectors/image-generation/storage/r2.service.integration.spec.ts'})


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
            elif name in EXTERNAL_ARMS:
                group = 'maintained-external-live'
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


def unpack_pinned_billing_source(root, scratch):
    """Unpack the committed Billing3a snapshot after proving every byte against its pins.

    → the directory to hand the spec as BILLING_CUSTODIAN_SOURCE, or None when the lineage
    record is absent (the dependent tests then stay skipped, i.e. not_measured). A record that
    is present but does not match is a tampered input and refuses the run.
    """
    if not (root / PINNED_BILLING_SOURCE).is_file():
        return None
    lineage = json.loads(checked_file(root, PINNED_BILLING_SOURCE).read_text())
    pins = json.loads(checked_file(root, BILLING_MODULE_PINS).read_text())
    archive = checked_file(root, lineage['archive']['path'])
    data = archive.read_bytes()
    native = subprocess.run(['git', '-C', str(root), 'show', 'HEAD:' + lineage['archive']['path']],
                            capture_output=True, check=True).stdout
    if hashlib.sha256(data).hexdigest() != lineage['archive']['sha256'] or native != data:
        raise Refusal('pinned source archive differs from its lineage or committed revision')
    target = scratch / 'billing-3a-source'
    target.mkdir(mode=0o700)
    with tarfile.open(fileobj=__import__('io').BytesIO(data), mode='r:gz') as bundle:
        members = bundle.getmembers()
        if sorted(m.name for m in members) != sorted(pins) or any(not m.isreg() for m in members):
            raise Refusal('pinned source archive membership differs from the module pins')
        for member in members:
            body = bundle.extractfile(member).read()
            if hashlib.sha256(body).hexdigest() != pins[member.name]:
                raise Refusal('pinned source file differs from its pin')
            (target / member.name).write_bytes(body)
    return str(target)


class _Owned:
    def __init__(self, pg, redis, extras=()):
        self.pg, self.redis, self.extras = pg, redis, list(extras)

    def environment(self):
        values = {'NODE_ENV': 'test', 'MC_OWNED_STORES': '1', 'STT_PROVIDER_GROQ_ENABLED': 'false'}
        if self.pg:
            values['DATABASE_URL'] = self.pg.url
        if self.redis:
            values.update(REDIS_HOST=self.redis.host, REDIS_PORT=str(self.redis.port),
                          REDIS_PREFIX='mc-owned:' + uuid.uuid4().hex[:12] + ':')
        return values

    def describe(self):
        # No URL, port or path is recorded: the evidence is that stores existed and were removed.
        return {'postgres': ('local-binaries-unix-socket' if getattr(self.pg, 'socket_dir', None)
                             else 'container-ephemeral-port') if self.pg else None,
                'redis': ('local-binary-kernel-port' if self.redis and not getattr(self.redis, 'container', False)
                          else 'container-ephemeral-port') if self.redis else None,
                'torn_down_in_finally': True}

    def close(self):
        first = None
        for store in (self.redis, self.pg):
            try:
                store and store.close()
            except Exception as error:
                first = first or error
        if first:
            raise first


def open_owned_stores(home, path):
    pg = OwnedPostgres(home, path)
    try:
        return _Owned(pg, OwnedRedis(home, path))
    except BaseException:
        pg and pg.close()
        raise


class _Stub:
    def __init__(self, child, port):
        self.child, self.port = child, port

    def close(self):
        self.child.terminate()
        try:
            self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()


def open_s3_stub(scratch, path, credentials):
    node = shutil.which('node', path=path)
    if not node:
        raise StoreUnavailable('node is not available')
    env = {'PATH': path, 'HOME': str(scratch / 'home'),
           'STUB_ACCESS_KEY_ID': credentials['R2_ACCESS_KEY_ID'],
           'STUB_SECRET_ACCESS_KEY': credentials['R2_SECRET_ACCESS_KEY']}
    child = subprocess.Popen([node, str(ROOT / 'scripts/s3-contract-stub.mjs')], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        port = json.loads(child.stdout.readline())['port']
    except (ValueError, KeyError):
        child.kill()
        child.wait()
        raise StoreUnavailable('contract stub did not report a port')
    return _Stub(child, port)


def run_root_suites(root, suites, scratch, executor=execute, stores=None):
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
    open_stores = stores or open_owned_stores

    def run(argv, members, name, parser, env=env):
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

    def with_stores(label, members, build, extra_env=None, prepare=(), only=None, provision=None):
        """Run one execution against stores this process owns; always tear them down."""
        missing = [tool for tool in ('pnpm', 'node') if not shutil.which(tool, path=env['PATH'])]
        if not (root / 'node_modules/.bin/vitest').is_file():
            missing.append('owned Vitest dependency')
        if missing:
            return {'members': members, 'verdict': 'not_measured', 'exit_code': 127,
                    'reason': 'missing local runner: ' + ', '.join(missing)}
        home = scratch / ('stores-' + label)
        home.mkdir(mode=0o700)
        try:
            owned = open_stores(home, env['PATH'])
        except StoreUnavailable as error:
            return {'members': members, 'verdict': 'not_measured', 'exit_code': 127,
                    'reason': 'owned disposable store unavailable: ' + str(error)}
        try:
            provided = owned.environment()
            if only:  # hand the child just these names, nothing else the stores define
                provided = {k: v for k, v in provided.items() if k in only}
            owned_env = {**env, **provided, **(extra_env or {}), **(provision(owned, home) if provision else {})}
            for step, argv in enumerate(prepare):
                done = executor(argv, root, owned_env, deadline, scratch, label + '-prepare-' + str(step))
                done.pop('output')
                if done['exit_code']:
                    return {'argv': argv, 'members': members, 'exit_code': done['exit_code'],
                            'verdict': 'not_measured' if done['exit_code'] in (124, 127) else 'failed',
                            'reason': 'owned-store preparation step failed'}
            result = build(owned_env)
            result['owned_stores'] = owned.describe()
            return result
        finally:
            owned.close()

    def owned_vitest(label, members, extra_env=None, seed=False):
        report = scratch / (label + '.json')
        argv = ['pnpm', 'exec', 'vitest', 'run', '--config',
                'vitest.integration.config.ts' if label != 'app-e2e' else 'vitest.e2e.config.ts',
                '--no-file-parallelism',  # spec files share the run's one database and Redis
                '--reporter=json', '--outputFile=' + str(report), *members]
        prepare = [['pnpm', 'exec', 'prisma', 'generate'], ['pnpm', 'exec', 'prisma', 'migrate', 'deploy']]
        if seed:
            prepare.append(['node', 'scripts/seed-owned-api-key.mjs'])
        extra = dict(extra_env or {})
        if seed:
            extra['INTEGRATION_API_KEY'] = uuid.uuid4().hex + uuid.uuid4().hex
        return with_stores(label, members, lambda owned_env: run(
            argv, members, label, lambda raw: vitest_counts(json.loads(report.read_text()), members, root),
            env=owned_env), extra, prepare)

    def owned_bench_partial(member):
        label, report = 'bench-owned-postgres-partial', scratch / 'bench-owned-postgres-partial.json'

        def provision(owned, home):
            if not getattr(owned.pg, 'socket_dir', None):
                raise StoreUnavailable('the bench spec needs a local Unix-socket PostgreSQL')
            owned.pg.provision_bench_fixture()
            # The spec binds Unix sockets here, so the directory must be short (~107-byte limit).
            base = next((c for c in (os.environ.get('XDG_RUNTIME_DIR'), '/dev/shm', str(home))
                         if c and os.path.isdir(c) and os.access(c, os.W_OK) and len(c) <= 40), None)
            if base is None:
                raise StoreUnavailable('no private directory short enough for the spec sockets')
            sockets = Path(tempfile.mkdtemp(prefix='s', dir=base))
            owned.pg.closers.append(lambda: shutil.rmtree(sockets, ignore_errors=True))
            return {'BENCH_OWNED_TEST_PG_SOCKET': owned.pg.socket_dir, 'BENCH_OWNED_TEST_SOCKET_ROOT': str(sockets)}

        argv = ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', '--no-file-parallelism',
                '--reporter=json', '--outputFile=' + str(report), '-t', BENCH_PARTIAL[member], member]
        try:
            result = with_stores(label, [member], lambda owned_env: run(
                argv, [member], label, lambda raw: vitest_counts(json.loads(report.read_text()), [member], root),
                env=owned_env), None,
                [['pnpm', 'exec', 'prisma', 'generate']], ('DATABASE_URL', 'NODE_ENV'), provision)
        except StoreUnavailable as error:
            return {'members': [member], 'verdict': 'not_measured', 'exit_code': 127, 'reason': str(error)}
        result['partial'] = 'tests needing BENCH_OWNED_NATIVE_TEST_BINARY are filtered out and count as skipped'
        return result

    def stub_vitest(label, members):
        report = scratch / (label + '.json')
        credentials = {'R2_ACCESS_KEY_ID': 'stub' + uuid.uuid4().hex[:16],
                       'R2_SECRET_ACCESS_KEY': uuid.uuid4().hex + uuid.uuid4().hex,
                       'R2_ACCOUNT_ID': 'contract-stub', 'RUN_INTEGRATION': '1'}
        try:
            stub = open_s3_stub(scratch, env['PATH'], credentials)
        except StoreUnavailable as error:
            return {'members': members, 'verdict': 'not_measured', 'exit_code': 127,
                    'reason': 'contract stub unavailable: ' + str(error)}
        try:
            run_env = {**env, **credentials, 'R2_ENDPOINT': 'http://127.0.0.1:%d' % stub.port}
            argv = ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
                    '--reporter=json', '--outputFile=' + str(report), *members]
            result = run(argv, members, label, lambda raw: vitest_counts(json.loads(report.read_text()), members, root),
                         env=run_env)
            result['verification_kind'] = ('local S3-compatible contract stub with SigV4 verification; '
                                           'not Cloudflare R2')
            return result
        finally:
            stub.close()
    for index, suite in enumerate(suites):
        name, members = suite['suite'], suite['members']
        row = {'suite': name, 'members': members, 'executions': []}
        if name == 'maintained-app-e2e':
            result = owned_vitest('app-e2e', members)
            row['executions'].append(result)
            row['verdict'] = result['verdict']
            if result['verdict'] != 'verified':
                row.update(held_members=members, reason=result.get('reason', 'AppE2E did not verify'))
        elif name == 'maintained-external-live':
            row.update(verdict='not_measured', held_members=members,
                       reason='each member needs a live external service or an externally built native binary',
                       classification={m: {'class': EXTERNAL_ARMS[m][0], 'requires': EXTERNAL_ARMS[m][1]}
                                       for m in members})
            for bench in [m for m in members if m in BENCH_PARTIAL]:
                # Measure what IS measurable in a held file: everything except the tests that need the
                # externally built native binary. Those are filtered out, so they count as skipped and
                # the file can never verify without the binary.
                row['executions'].append(owned_bench_partial(bench))
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
            report = scratch / (name + '.json')
            argv = ['pnpm', 'exec', 'vitest', 'run', '--reporter=json', '--outputFile=' + str(report), *members]
            source = unpack_pinned_billing_source(root, scratch)
            # Some unit specs boot the real AppModule, whose BullMQ/ioredis clients dial the default
            # Redis address. Give them an owned Redis so the result does not depend on whatever
            # happens to listen on 6379 of the measuring host.
            result = with_stores('vitest-redis', members, lambda owned_env: run(
                argv, members, 'root-' + str(index),
                lambda raw: vitest_counts(json.loads(report.read_text()), members, root), env=owned_env),
                {'BILLING_CUSTODIAN_SOURCE': source} if source else None,
                only=('REDIS_HOST', 'REDIS_PORT', 'REDIS_PREFIX'))
            if result.get('reason', '').startswith('owned disposable store unavailable'):
                # Fall back to the ambient default, and say so: this result then depends on the host.
                result = run(argv, members, 'root-' + str(index),
                             lambda raw: vitest_counts(json.loads(report.read_text()), members, root),
                             env={**env, 'BILLING_CUSTODIAN_SOURCE': source} if source else env)
                result['owned_redis'] = False
            else:
                result['owned_redis'] = True
            row['executions'].append(result)
            result['pinned_billing_source'] = (
                {'lineage': PINNED_BILLING_SOURCE, 'verified_files': len(json.loads(
                    (root / BILLING_MODULE_PINS).read_text()))} if source else None)
            row['verdict'] = row['executions'][0]['verdict']
            if row['verdict'] != 'verified':
                row['external_skips'] = {n: {'class': c, 'requires': r, 'note': t}
                                         for n, (c, r, t) in EXTERNAL_SKIPS.items() if n in members}
        elif name == 'maintained-integration':
            def pick(allowed):
                return [n for n in members if n in allowed]
            plain, flagged = pick(OFFLINE_INTEGRATION), pick(OFFLINE_RUN_FLAG)
            owned, seeded = pick(OWNED_STORE_INTEGRATION), pick(OWNED_STORE_SEEDED_KEY)
            stubbed = pick(STUB_STORAGE_INTEGRATION)
            selected = set(plain + flagged + owned + seeded + stubbed)
            held = [n for n in members if n not in selected]
            if held:
                row.update(held_members=held, reason='unclassified integration spec: no declared executor, held fail-closed')

            def local_vitest(label, chosen, extra_env):
                report = scratch / (label + '.json')
                return run(['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
                            '--reporter=json', '--outputFile=' + str(report), *chosen], chosen, label,
                           lambda raw: vitest_counts(json.loads(report.read_text()), chosen, root),
                           env={**env, **extra_env})
            if plain:
                row['executions'].append(local_vitest('root-' + str(index), plain, {}))
            if flagged:
                result = local_vitest('offline-run-flag', flagged, {'RUN_INTEGRATION': '1'})
                result['credential_conditional_tests'] = {n: OFFLINE_RUN_FLAG[n] for n in flagged}
                row['executions'].append(result)
            if owned:
                row['executions'].append(owned_vitest('owned-stores', owned))
            if seeded:
                row['executions'].append(owned_vitest('owned-stores-seeded-key', seeded, {'RUN_INTEGRATION': '1'}, seed=True))
            if stubbed:
                row['executions'].append(stub_vitest('storage-contract-stub', stubbed))
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
        document['remaining'] = [
            'maintained-external-live: ' + str(len(EXTERNAL_ARMS)) + ' arms need a live external service '
            'or an externally built native binary (see EXTERNAL_ARMS and the impossibility evidence)']
    try:
        document['results'] = (run_root_suites(ROOT, suites, scratch) if unit == '.' else
                               run_suites(ROOT, unit, suites, scratch))
    except (Refusal, ValueError, KeyError, OSError):
        document['remaining'] = ['invalid or absent execution evidence; inspect private raw suite files']
        code = 1
    else:
        code = execution_code(document['results'])
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
