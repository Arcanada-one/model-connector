"""The disposable stores really start, answer, sit on kernel-chosen endpoints and leave nothing.

Runs against whatever backend the runner has (local binaries or a container runtime).
MC_REQUIRE_STORES=1 (CI) turns "no backend" into a failure instead of a skip.
"""
from pathlib import Path
import os
import socket
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import owned_stores  # noqa: E402


class Smoke(unittest.TestCase):
    def test_postgres_and_redis_start_answer_and_are_removed(self):
        path = os.environ.get('PATH', os.defpath)
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            try:
                pg = owned_stores.OwnedPostgres(home, path)
                redis = owned_stores.OwnedRedis(home, path)
            except owned_stores.StoreUnavailable as error:
                if os.environ.get('MC_REQUIRE_STORES') == '1':
                    self.fail('required disposable stores unavailable: ' + str(error))
                self.skipTest(str(error))
            port = redis.port
            try:
                self.assertNotEqual(port, 6379)
                self.assertTrue(redis._ping())
                self.assertNotIn(':5432', pg.url)
                if getattr(pg, 'socket_dir', None):
                    psql = owned_stores._which('psql', path) or str(Path(owned_stores._which('postgres', path)).parent / 'psql')
                    out = subprocess.run([psql, '-h', pg.socket_dir, '-U', 'dev', '-d', pg.database, '-Atc', 'select 1'],
                                         capture_output=True, text=True, timeout=30)
                    self.assertEqual(out.stdout.strip(), '1', out.stderr)
            finally:
                redis.close()
                pg.close()
            with self.assertRaises(OSError):
                socket.create_connection(('127.0.0.1', port), timeout=1).close()
            self.assertEqual(list(home.rglob('postgresql.conf')), [])


if __name__ == '__main__':
    unittest.main()
