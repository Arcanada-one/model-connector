"""RED controls for the root AppE2E arm: breaking the app must turn the arm red.

A control that cannot fail measures nothing. This copies the tracked tree to a private
directory, links node_modules, mutates the copy (never the working tree), and runs the
real AppE2E arm of scripts/graph_full_suite.py against disposable stores it starts itself.
The unmodified copy must verify; each mutant must come out `failed`.
Skipped (not green) when the runner can start neither local binaries nor containers.
"""
from pathlib import Path
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('full_suite', ROOT / 'scripts/graph_full_suite.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)

MUTANTS = {
    'auth-guard-opens-every-route': ('src/auth/auth.guard.ts', 'if (isPublic) return true;', 'return true;'),
    'health-reports-down': ('src/health/health.controller.ts', "status: 'ok', timestamp", "status: 'down', timestamp"),
}


class AppE2ERedControls(unittest.TestCase):
    def tree(self, mutant=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        copy = Path(temp.name) / 'tree'
        names = subprocess.run(['git', '-C', str(ROOT), 'ls-files', '-z'], capture_output=True,
                               check=True).stdout.decode().split('\0')
        for name in filter(None, names):
            if (ROOT / name).is_file() and not (ROOT / name).is_symlink():
                (copy / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, copy / name)
        (copy / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        if mutant:
            path, old, new = MUTANTS[mutant]
            text = (copy / path).read_text()
            self.assertEqual(text.count(old), 1, 'mutation site moved: ' + mutant)
            (copy / path).write_text(text.replace(old, new))
        scratch = Path(temp.name) / 'scratch'
        scratch.mkdir(mode=0o700)
        return copy, scratch

    def arm(self, mutant=None):
        if not (ROOT / 'node_modules/.bin/vitest').is_file():
            self.skipTest('dependencies not installed')
        copy, scratch = self.tree(mutant)
        suites = [s for s in subject.plan('.', ['test/app.e2e-spec.ts'])]
        return subject.run_root_suites(copy, suites, scratch)[0]

    def test_unmodified_app_verifies(self):
        row = self.arm()
        if row['verdict'] == 'not_measured':
            self.skipTest(row['executions'][0].get('reason', 'stores unavailable'))
        self.assertEqual(row['verdict'], 'verified', row)
        self.assertEqual(row['executions'][0]['counts']['skipped'], 0)

    def test_every_mutant_fails_the_arm(self):
        for name in MUTANTS:
            with self.subTest(mutant=name):
                row = self.arm(name)
                if row['verdict'] == 'not_measured':
                    self.skipTest(row['executions'][0].get('reason', 'stores unavailable'))
                self.assertEqual(row['verdict'], 'failed', row)
                self.assertTrue(row['executions'][0]['exit_code'] or row['executions'][0]['counts']['failed'])


if __name__ == '__main__':
    unittest.main()
