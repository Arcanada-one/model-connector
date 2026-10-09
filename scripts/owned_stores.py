"""Disposable PostgreSQL and Redis stores owned by one test run.

Nothing here connects to, reuses or names a shared or production store:

* every store is created from scratch inside a private directory that the caller
  owns, on a kernel-chosen endpoint (PostgreSQL: a Unix socket in that directory and
  no TCP listener; Redis: a loopback port taken from the kernel by binding port 0;
  containers: a loopback port the container runtime picks);
* the store is torn down by ``close()`` (callers use ``try/finally``) and its data
  directory is removed with the private directory;
* binaries on PATH are preferred, a container runtime is the fallback, and a host
  with neither raises ``StoreUnavailable`` so the caller reports not_measured
  instead of pretending.
"""
from pathlib import Path
import glob
import os
import shutil
import socket
import subprocess
import tempfile
import time
import uuid


class StoreUnavailable(Exception):
    """The runner has no way to start this store; the row is not measured."""


def _which(name, path):
    found = shutil.which(name, path=path)
    if found:
        return found
    if name in ('initdb', 'postgres', 'pg_isready'):
        for candidate in sorted(glob.glob('/usr/lib/postgresql/*/bin/' + name), reverse=True):
            if os.access(candidate, os.X_OK):
                return candidate
    return None


def _docker_ready(path):
    docker = shutil.which('docker', path=path)
    if not docker:
        return None
    probe = subprocess.run([docker, 'info', '--format', '{{.ServerVersion}}'],
                           capture_output=True, timeout=30)
    return docker if probe.returncode == 0 else None


def free_loopback_port():
    """Ask the kernel for a free loopback port (bind port 0)."""
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def _wait(check, seconds, what):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.2)
    raise StoreUnavailable(what + ' did not become ready')


class _Store:
    def __init__(self):
        self.closers = []

    def close(self):
        errors = []
        while self.closers:
            try:
                self.closers.pop()()
            except Exception as error:  # teardown must run every closer
                errors.append(error)
        if errors:
            raise errors[0]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class OwnedPostgres(_Store):
    """A throw-away PostgreSQL. ``url`` is the DATABASE_URL to hand a test."""

    def __init__(self, scratch, env_path, database='connector_test'):
        super().__init__()
        self.url = None
        self.database = database
        try:
            initdb, postgres = _which('initdb', env_path), _which('postgres', env_path)
            if initdb and postgres:
                self._local(Path(scratch), initdb, postgres)
            elif _docker_ready(env_path):
                self._container(_docker_ready(env_path))
            else:
                raise StoreUnavailable('no postgres binaries and no usable container runtime')
        except BaseException:
            self.close()
            raise

    def _local(self, scratch, initdb, postgres):
        root = Path(scratch) / 'mc-owned-postgres'
        data = root / 'data'
        # A Unix socket path is limited to ~107 bytes. Keep the socket directory beside the data
        # directory when that fits, else under a short private directory of the same owner;
        # refuse rather than truncate.
        limit = 100 - len('/mc-owned-postgres/socket/.s.PGSQL.5432')
        base = None
        for candidate in (Path(scratch), Path(os.environ.get('XDG_RUNTIME_DIR', '/nonexistent')), Path('/dev/shm')):
            if len(str(candidate)) + (0 if candidate == Path(scratch) else 12) <= limit and candidate.is_dir() and os.access(candidate, os.W_OK):
                base = candidate
                break
        if base is None:
            raise StoreUnavailable('no private directory short enough for a Unix socket')
        sock_root = Path(tempfile.mkdtemp(prefix='mcpg', dir=base)) if base != Path(scratch) else root
        sock = sock_root / 'mc-owned-postgres' / 'socket' if base != Path(scratch) else root / 'socket'
        sock.mkdir(parents=True, mode=0o700, exist_ok=True)
        root.mkdir(parents=True, mode=0o700, exist_ok=True)
        if base != Path(scratch):
            self.closers.append(lambda: shutil.rmtree(sock_root, ignore_errors=True))
        subprocess.run([initdb, '-D', str(data), '-U', 'dev', '-A', 'trust'],
                       check=True, capture_output=True, timeout=120)
        log = open(root / 'postgres.log', 'ab')
        child = subprocess.Popen(
            [postgres, '-D', str(data), '-c', "listen_addresses=", '-c', 'unix_socket_directories=' + str(sock),
             '-c', 'shared_buffers=32MB', '-c', 'max_connections=60'],
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)

        def stop():
            child.terminate()
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            log.close()
        self.closers.append(stop)
        self.closers.append(lambda: shutil.rmtree(root, ignore_errors=True))
        _wait(lambda: child.poll() is None and (sock / '.s.PGSQL.5432').exists(), 60, 'postgres')
        psql = _which('psql', os.environ.get('PATH', os.defpath)) or str(Path(postgres).parent / 'psql')
        self._psql = psql
        subprocess.run([psql, '-h', str(sock), '-U', 'dev', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
                        '-c', 'CREATE DATABASE ' + self.database], check=True, capture_output=True, timeout=60)
        self.socket_dir = str(sock)
        self.url = 'postgresql://dev@localhost/' + self.database + '?host=' + str(sock)

    def provision_bench_fixture(self):
        """Roles and databases the bench-reservation spec expects (owned socket only)."""
        if not getattr(self, 'socket_dir', None):
            raise StoreUnavailable('bench fixture needs the local Unix-socket store')
        for sql in ('CREATE ROLE bench_primary_fixture_writer LOGIN',
                    'CREATE ROLE bench_checkpoint_fixture_writer LOGIN',
                    'CREATE DATABASE bench_primary_fixture',
                    'CREATE DATABASE bench_checkpoint_fixture'):
            subprocess.run([self._psql, '-h', self.socket_dir, '-U', 'dev', '-d', 'postgres',
                            '-v', 'ON_ERROR_STOP=1', '-c', sql],
                           check=True, capture_output=True, timeout=60)

    def _container(self, docker):
        name = 'mc-owned-pg-' + uuid.uuid4().hex[:12]
        subprocess.run([docker, 'run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::5432',
                        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=mc_owned',
                        '-e', 'POSTGRES_DB=' + self.database, 'postgres:16'],
                       check=True, capture_output=True, timeout=300)
        self.closers.append(lambda: subprocess.run([docker, 'rm', '-f', name], capture_output=True, timeout=60))
        mapped = subprocess.run([docker, 'port', name, '5432/tcp'], check=True, capture_output=True,
                                timeout=30).stdout.decode().split()[0]
        port = int(mapped.rsplit(':', 1)[1])

        def ready():
            return subprocess.run([docker, 'exec', name, 'pg_isready', '-U', 'dev', '-d', self.database],
                                  capture_output=True, timeout=30).returncode == 0
        _wait(ready, 90, 'postgres container')
        self.url = 'postgresql://dev@127.0.0.1:%d/%s' % (port, self.database)


class OwnedRedis(_Store):
    """A throw-away Redis on a kernel-chosen loopback port."""

    def __init__(self, scratch, env_path):
        super().__init__()
        self.host, self.port, self.container = '127.0.0.1', None, False
        try:
            server = _which('redis-server', env_path)
            if server:
                self._local(Path(scratch), server)
            elif _docker_ready(env_path):
                self._container(_docker_ready(env_path))
            else:
                raise StoreUnavailable('no redis-server binary and no usable container runtime')
        except BaseException:
            self.close()
            raise

    def _ping(self):
        try:
            with socket.create_connection((self.host, self.port), timeout=2) as conn:
                conn.sendall(b'*1\r\n$4\r\nPING\r\n')
                return conn.recv(16).startswith(b'+PONG')
        except OSError:
            return False

    def _local(self, scratch, server):
        root = Path(scratch) / 'mc-owned-redis'
        root.mkdir(mode=0o700)
        self.closers.append(lambda: shutil.rmtree(root, ignore_errors=True))
        for _ in range(5):  # the port can be taken between probe and bind
            port = free_loopback_port()
            log = open(root / 'redis.log', 'ab')
            child = subprocess.Popen(
                [server, '--port', str(port), '--bind', '127.0.0.1', '--dir', str(root), '--save', '',
                 '--appendonly', 'no', '--protected-mode', 'yes', '--daemonize', 'no'],
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            self.port = port
            end = time.monotonic() + 15
            while time.monotonic() < end and child.poll() is None and not self._ping():
                time.sleep(0.1)
            if child.poll() is None and self._ping():
                def stop(child=child, log=log):
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                    log.close()
                self.closers.append(stop)
                return
            if child.poll() is None:
                child.kill()
                child.wait()
            log.close()
        raise StoreUnavailable('redis did not start on a kernel-chosen port')

    def _container(self, docker):
        self.container = True
        name = 'mc-owned-redis-' + uuid.uuid4().hex[:12]
        subprocess.run([docker, 'run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::6379', 'redis:7',
                        'redis-server', '--save', '', '--appendonly', 'no'],
                       check=True, capture_output=True, timeout=300)
        self.closers.append(lambda: subprocess.run([docker, 'rm', '-f', name], capture_output=True, timeout=60))
        mapped = subprocess.run([docker, 'port', name, '6379/tcp'], check=True, capture_output=True,
                                timeout=30).stdout.decode().split()[0]
        self.port = int(mapped.rsplit(':', 1)[1])
        _wait(self._ping, 60, 'redis container')
