#!/usr/bin/env bash
# Native Compose consumer network contract, rendered by the real `docker compose config`.
# Exit 0 = contract holds. Exit 127 = the Compose tool itself is missing (not measured).
# Exit 1 = Compose ran and the rendering/contract is wrong. The failing cause is printed
# (sanitized), never collapsed into one generic refusal.
set -euo pipefail
python3 - <<'PY'
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def sanitize(text, *private):
    for value in filter(None, private):
        text = text.replace(value, '<private>')
    text = re.sub(r'(?i)(token|password|secret|authorization)[=:]\S+', r'\1=<redacted>', text)
    return text.strip()[-1500:]


def sha256(path):
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return 'unreadable'


def run(argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, timeout=30, **kw)


PROBE = {}


def tool_record():
    docker = shutil.which('docker')
    print('docker binary:', docker, 'sha256', sha256(docker) if docker else '-')
    if not docker:
        return docker
    for label, argv in (('docker version', [docker, '--version']),
                        ('compose version', [docker, 'compose', 'version'])):
        try:
            done = run(argv)
            print(label + ':', sanitize(done.stdout or done.stderr, str(Path.home())), '(exit %d)' % done.returncode)
            PROBE[label] = (done.returncode, (done.stdout + done.stderr))
        except Exception as error:  # a record must never hide the real measurement
            print(label + ': unavailable (%s)' % type(error).__name__)
    seen = set()
    for base in (Path.home() / '.docker/cli-plugins', Path('/usr/local/lib/docker/cli-plugins'),
                 Path('/usr/lib/docker/cli-plugins'), Path('/usr/libexec/docker/cli-plugins')):
        plugin = base / 'docker-compose'
        if plugin.exists() and plugin.resolve() not in seen:
            seen.add(plugin.resolve())
            info = plugin.stat()
            print('compose plugin:', str(plugin).replace(str(Path.home()), '<home>'), 'sha256', sha256(plugin),
                  'mode %o uid %d gid %d size %d' % (info.st_mode & 0o7777, info.st_uid, info.st_gid, info.st_size),
                  'executable_by_this_user=%s' % os.access(plugin, os.X_OK), 'running_uid=%d' % os.getuid())
            try:
                meta = run([str(plugin), 'docker-cli-plugin-metadata'])
                print('  plugin metadata (exit %d):' % meta.returncode, sanitize(meta.stdout or meta.stderr, str(Path.home()))[:300])
            except Exception as error:
                print('  plugin metadata: not runnable (%s)' % type(error).__name__)
    try:  # the CLI's own account of the plugins it found and why it rejected any (client side only)
        info = run([docker, 'info', '--format', '{{json .ClientInfo.Plugins}}'])
        print('docker client plugins (exit %d):' % info.returncode, sanitize(info.stdout or info.stderr, str(Path.home()))[:1500])
    except Exception as error:
        print('docker client plugins: unavailable (%s)' % type(error).__name__)
    print('environment: HOME set=%s DOCKER_CONFIG set=%s DOCKER_HOST set=%s'
          % (bool(os.environ.get('HOME')), bool(os.environ.get('DOCKER_CONFIG')), bool(os.environ.get('DOCKER_HOST'))))
    return docker


def refuse(kind, detail, code=1):
    print('REFUSED native Compose consumer network contract [%s]: %s' % (kind, detail), file=sys.stderr)
    raise SystemExit(code)


docker = tool_record()
if not docker:
    refuse('tool_missing', 'docker is not on PATH', 127)
code, text = PROBE.get('compose version', (0, ''))
if code != 0 and re.search(r"(?i)unknown command|is not a docker command|unknown shorthand flag", text):
    # The contract was never rendered: the toolchain, not the repository, is what is missing here.
    refuse('compose_plugin_missing', sanitize(text, str(Path.home())), 127)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / 'docker-compose.yml').write_bytes(Path('docker-compose.yml').read_bytes())
    # Render only a disposable empty environment; never read production credentials.
    (root / '.env').write_text('')
    try:
        result = run([docker, 'compose', '--project-directory', str(root),
                      '-f', str(root / 'docker-compose.yml'), 'config', '--format', 'json'])
    except subprocess.TimeoutExpired:
        refuse('compose_timeout', 'docker compose config exceeded 30 s')
    except OSError as error:
        refuse('tool_missing', 'docker could not be executed: %s' % type(error).__name__, 127)
    stderr = sanitize(result.stderr, str(root), str(Path.home()))
    if result.returncode != 0:
        if re.search(r"(?i)is not a docker command|unknown shorthand flag|unknown command.*compose", stderr):
            refuse('compose_plugin_missing', stderr, 127)
        refuse('compose_render_failed', 'exit %d: %s' % (result.returncode, stderr))
    try:
        config = json.loads(result.stdout)
    except ValueError as error:
        refuse('compose_output_not_json', '%s; stderr: %s' % (type(error).__name__, stderr))
    try:
        app = config['services']['model-connector']
        network = config['networks']['assistant-native']
        assert network['name'] == 'arcanada-assistant_default' and network['external'] is True, 'assistant-native network identity'
        assert not network.get('ipam'), 'assistant-native network must not declare ipam'
        assert app['networks']['assistant-native']['aliases'] == ['connector.arcanada.one'], 'consumer alias'
        assert {'default', 'transcribator-api'}.issubset(app['networks']), 'retained networks'
        # Docker's actual normalized configuration must retain the local native port.
        assert len(app['ports']) == 1, 'exactly one published port'
        port = app['ports'][0]
        assert port['host_ip'] == '127.0.0.1' and port['target'] == 3900 and str(port['published']) == '3900', 'loopback 3900'
        assert port.get('protocol', 'tcp') == 'tcp', 'tcp protocol'
    except (AssertionError, KeyError, TypeError) as error:
        refuse('contract_assertion_failed', '%s %s' % (type(error).__name__, error))
print('PASS native Compose consumer alias, retained networks and loopback3900')
PY
