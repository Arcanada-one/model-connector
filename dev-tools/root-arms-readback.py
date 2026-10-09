"""Run the root complete-fallback suite and read back, per row, what became measurable.

Asserts only what the bounded executors own: AppE2E and the integration group must come
out `verified` (real execution against stores this run created), and every arm that
cannot be measured here must still be reported `not_measured` with a precise class, never
silently green. Other rows are printed, not asserted. Exit 0 iff those expectations hold.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import graph_full_suite as suite  # noqa: E402


def main():
    # Some maintained specs bind Unix sockets under TMPDIR (~107-byte path limit), so the private
    # directory must be short. Prefer a per-user runtime directory, then /dev/shm.
    base = next((c for c in (os.environ.get('XDG_RUNTIME_DIR'), '/dev/shm')
                 if c and os.path.isdir(c) and os.access(c, os.W_OK)), None)
    with tempfile.TemporaryDirectory(prefix='rb', dir=base) as temp:
        os.chmod(temp, 0o700)
        env = dict(os.environ, TMPDIR=temp)
        done = subprocess.run(['bash', 'scripts/graph-full-suite.sh', '.'], cwd=ROOT, env=env,
                              capture_output=True, text=True)
        sys.stdout.write(done.stdout)
        found = re.search(r'Full-suite evidence: (\S+)', done.stdout)
        if not found:
            print('READBACK_FAIL: no evidence document', done.stderr[-500:])
            return 1
        report = json.loads(Path(found[1]).read_text())
        rows = {r['suite']: r for r in report['results']}
        print('head', report['head'], 'exit_code', report['exit_code'])
        for name, row in sorted(rows.items()):
            print('  %-30s %s' % (name, row['verdict']))
            for execution in row.get('executions', []):
                print('      %-12s exit=%s counts=%s %s' % (execution.get('verdict'), execution.get('exit_code'),
                                                           execution.get('counts'), execution.get('reason', '')))
                if execution.get('verdict') == 'failed' and execution.get('raw_log'):
                    print('      --- raw log tail ---')
                    scratch = Path(execution['raw_log']).parent
                    for report_path in sorted(scratch.glob('*.json')):
                        if report_path.name == 'execution.json':
                            continue
                        for file in json.loads(report_path.read_text()).get('testResults', []):
                            for case in file.get('assertionResults', []):
                                if case.get('status') == 'failed':
                                    print('      FAILED', file['name'], '::', case.get('title'))
                                    print('        ', (case.get('failureMessages') or [''])[0][:700])
                            if file.get('status') == 'failed' and not file.get('assertionResults'):
                                print('      FILE FAILED', file['name'], file.get('message', '')[:700])
        problems = []
        for name in ('maintained-app-e2e', 'maintained-integration'):
            if rows.get(name, {}).get('verdict') != 'verified':
                problems.append(name + ' is not verified')
        live = rows.get('maintained-external-live', {})
        if live.get('verdict') != 'not_measured' or sorted(live.get('classification', {})) != sorted(suite.EXTERNAL_ARMS):
            problems.append('external arms are not held and classified exactly')
        for problem in problems:
            print('READBACK_FAIL:', problem)
        return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
