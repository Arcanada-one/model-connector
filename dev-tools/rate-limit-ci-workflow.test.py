"""Execute only the CI glue with disposable command doubles, never Docker/services."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/ci.yml'


def step(name):
    lines = WORKFLOW.read_text().splitlines()
    start = lines.index('      - name: ' + name)
    assert lines[start + 1] == '        run: |'
    body = []
    for line in lines[start + 2:]:
        if line and not line.startswith('          '):
            break
        body.append(line)
    return textwrap.dedent('\n'.join(body))


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='mc-ci-glue-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.events = self.root / 'events.jsonl'
        docker = self.bin / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json,os,sys
a=sys.argv[1:]
event={'command':a[0]}
if a[0]=='run':
 name=a[a.index('--name')+1]
 expected='mc-rate-limit-123-2'
 assert name==expected
 assert '--network=host' in a and '--env-file' not in a
 assert 'DATABASE_URL=postgresql://test:test@localhost:15432/connector_test' in a
 assert 'REDIS_HOST=127.0.0.1' in a and 'REDIS_PORT=16379' in a
 assert 'REDIS_PREFIX=mc-rate-limit-ci:123:2:' in a
 script=a[-1]
 assert script.count('src/auth/rate-limit.integration.spec.ts')==1
 assert 'test:integration' not in script
 assert '--no-cache' in script and 'rate-limit-ci-report.mjs' in script
 event['name']=name
elif a[:2]==['rm','-f']:
 assert a[2]=='mc-rate-limit-123-2'
 event['name']=a[2]
with open(os.environ['MC_TEST_EVENTS'],'a') as f:f.write(json.dumps(event)+'\\n')
if a[0]=='run':sys.exit(int(os.environ.get('MC_TEST_RUN_EXIT','0')))
''')
        docker.chmod(0o700)
        self.env = {**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'],
                    'MC_TEST_EVENTS': str(self.events), 'GITHUB_RUN_ID': '123',
                    'GITHUB_RUN_ATTEMPT': '2', 'PYTHONDONTWRITEBYTECODE': '1'}

    def execute(self, name, **extra):
        return subprocess.run(['bash', '-c', step(name)], cwd=self.root,
                              env={**self.env, **extra}, capture_output=True, timeout=10)

    def read_events(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def test_success_cleans_only_run_container(self):
        result = self.execute('Six rate-limit assertions against disposable stores')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.read_events(), [
            {'command': 'run', 'name': 'mc-rate-limit-123-2'},
            {'command': 'rm', 'name': 'mc-rate-limit-123-2'}])

    def test_failure_remains_failure_and_cleans(self):
        result = self.execute('Six rate-limit assertions against disposable stores', MC_TEST_RUN_EXIT='42')
        self.assertEqual(result.returncode, 42)
        self.assertEqual(self.read_events()[-1], {'command': 'rm', 'name': 'mc-rate-limit-123-2'})

    def test_timeout_remains_timeout_and_cleans(self):
        timeout = self.bin / 'timeout'
        timeout.write_text('''#!/bin/sh
test "$1" = '--kill-after=5s' || exit 80
if test "$2" = 90s; then exit 124; fi
test "$2" = 15s || exit 81
shift 2
exec "$@"
''')
        timeout.chmod(0o700)
        result = self.execute('Six rate-limit assertions against disposable stores')
        self.assertEqual(result.returncode, 124)
        self.assertEqual(self.read_events(), [{'command': 'rm', 'name': 'mc-rate-limit-123-2'}])

    def test_dotenv_override_refuses_before_image_build(self):
        (self.root / '.env.integration').write_text('')
        result = self.execute('Build isolated rate-limit test stage')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.read_events(), [])

    def test_dangling_dotenv_link_refuses_before_image_build(self):
        (self.root / '.env.integration').symlink_to(self.root / 'absent')
        result = self.execute('Build isolated rate-limit test stage')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.read_events(), [])


if __name__ == '__main__':
    unittest.main()
