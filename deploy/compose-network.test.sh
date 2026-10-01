#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json
from pathlib import Path
import subprocess
import tempfile

try:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'docker-compose.yml').write_bytes(Path('docker-compose.yml').read_bytes())
        # Render only a disposable empty environment; never read production credentials.
        (root / '.env').write_text('')
        result = subprocess.run(['docker', 'compose', '--project-directory', str(root),
                                 '-f', str(root / 'docker-compose.yml'), 'config', '--format', 'json'],
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == 0
        config = json.loads(result.stdout)
        app = config['services']['model-connector']
        network = config['networks']['assistant-native']
        assert network['name'] == 'arcanada-assistant_default' and network['external'] is True
        assert not network.get('ipam')
        assert app['networks']['assistant-native']['aliases'] == ['connector.arcanada.one']
        assert {'default', 'transcribator-api'}.issubset(app['networks'])
        # Docker's actual normalized configuration must retain the local native port.
        assert len(app['ports']) == 1
        port = app['ports'][0]
        assert port['host_ip'] == '127.0.0.1' and port['target'] == 3900 and str(port['published']) == '3900'
        assert port.get('protocol', 'tcp') == 'tcp'
    print('PASS native Compose consumer alias, retained networks and loopback3900')
except Exception:
    raise SystemExit('REFUSED native Compose consumer network contract') from None
PY
