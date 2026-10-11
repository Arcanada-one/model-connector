#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json
import hashlib
import re
from pathlib import Path
import subprocess
import tempfile

phase = 'config_invocation'
exit_code = None
config_failure = 'config_nonzero'
stderr_sha256 = None
rejected_flag = None
try:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'docker-compose.yml').write_bytes(Path('docker-compose.yml').read_bytes())
        # Render only a disposable empty environment; never read production credentials.
        (root / '.env').write_text('')
        result = subprocess.run(['docker', 'compose', '--project-directory', str(root),
                                 '-f', str(root / 'docker-compose.yml'), 'config', '--format', 'json'],
                                capture_output=True, timeout=30)
        exit_code = result.returncode
        raw = result.stderr[:128 * 1024]
        stderr_sha256 = hashlib.sha256(raw).hexdigest()
        # Preserve private evidence, never print arbitrary stderr or a parsed untrusted flag.
        with tempfile.NamedTemporaryFile(prefix='mc-compose-stderr-', suffix='.log', delete=False) as log:
            log.write(raw)
        flags = re.findall(r'unknown (?:shorthand )?flag:?\s*[\"\']?(-{1,2}[a-z-]+)(?=\s|[\"\':]|$)', result.stderr.decode(errors='replace').lower())
        if len(flags) == 1 and flags[0] in ('--project-directory', '-f', '--format'):
            rejected_flag = flags[0]

        # Fixed taxonomy only; arbitrary stderr never reaches the public receipt.
        error_text = result.stderr.decode(errors='replace').lower()
        if 'is not a docker command' in error_text or 'unknown docker command' in error_text:
            config_failure = 'compose_plugin_unavailable'
        elif 'unknown flag' in error_text or 'unknown shorthand flag' in error_text:
            config_failure = 'compose_cli_flag'
        elif 'permission denied' in error_text:
            config_failure = 'compose_permission_denied'
        assert result.returncode == 0
        phase = 'config_parse'
        config = json.loads(result.stdout)
        app = config['services']['model-connector']
        phase = 'network_identity'
        network = config['networks']['assistant-native']
        assert network['name'] == 'arcanada-assistant_default' and network['external'] is True
        assert not network.get('ipam')
        phase = 'alias'
        assert app['networks']['assistant-native']['aliases'] == ['connector.arcanada.one']
        phase = 'service_membership'
        assert {'default', 'transcribator-api'}.issubset(app['networks'])
        # Docker's actual normalized configuration must retain the local native port.
        phase = 'ports'
        assert len(app['ports']) == 1
        port = app['ports'][0]
        assert port['host_ip'] == '127.0.0.1' and port['target'] == 3900 and str(port['published']) == '3900'
        assert port.get('protocol', 'tcp') == 'tcp'
    print('PASS native Compose consumer alias, retained networks and loopback3900')
except Exception as error:
    code = ('docker_absent' if isinstance(error, FileNotFoundError) else
            'timeout' if isinstance(error, subprocess.TimeoutExpired) else
            'invalid_json' if isinstance(error, json.JSONDecodeError) else
            config_failure if phase == 'config_invocation' and exit_code not in (None, 0) else
            'semantic_assertion' if isinstance(error, (AssertionError, KeyError, TypeError)) else 'UNKNOWN')
    print('COMPOSE_FAILURE_RECEIVING=' + json.dumps({'phase':phase,'exit_code':exit_code,'failure_code':code,'stderr_sha256':stderr_sha256,'rejected_flag':rejected_flag}))
    raise SystemExit('REFUSED native Compose consumer network contract') from None
PY
