#!/usr/bin/env python3
"""Opt-in Billing transaction engine; installation is not service admission.

No first-install path, migrations, grants, environment evaluation or payment calls.
The public entrypoint has fixed paths; injected adapters exist only in unit tests.
"""
import base64
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

STATE = Path('/var/lib/arcanada-deploy')
ENV = Path('/etc/arcanada/deploy-env/billing-arcana.env')
REPO = 'https://github.com/Arcanada-one/billing-arcana.git'
IMAGE = 'billing-arcana-billing'
CONTAINER = 'billing-arcana-billing-1'
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
CLEAN_ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LC_ALL': 'C',
             'GIT_TERMINAL_PROMPT': '0'}

class Refusal(Exception):
    pass


def protected(path, uid=0, directory=False, private=False):
    """Check every ancestor, never resolve a symlink into a trusted path."""
    path = Path(path).absolute()
    for node in [*reversed(path.parents), path]:
        st = node.lstat()
        if stat.S_ISLNK(st.st_mode) or st.st_uid not in (0, uid) or st.st_mode & 0o022:
            raise Refusal('unsafe ownership or path')
        if node != path and not stat.S_ISDIR(st.st_mode):
            raise Refusal('unsafe parent')
    st = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if st.st_uid != uid or not kind(st.st_mode) or (not directory and st.st_nlink != 1):
        raise Refusal('unsafe file kind or link count')
    if private and stat.S_IMODE(st.st_mode) != (0o700 if directory else 0o600):
        raise Refusal('private state mode required')
    return st


def tree_safe(root, uid=0):
    protected(root, uid, directory=True)
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(base) / name
            st = path.lstat()
            if st.st_uid != uid or st.st_mode & 0o022 or stat.S_ISLNK(st.st_mode):
                raise Refusal('unsafe checkout')
            if st.st_dev != root.stat().st_dev or not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                raise Refusal('checkout mount or special-file boundary')


def atomic_state(path, data):
    tmp = path.with_name('.pending-' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if tmp.exists():
            tmp.unlink()  # Only this exclusive pending state, never a baseline.


def exchange(left, right):
    libc = ctypes.CDLL(None, use_errno=True)
    fn = libc.renameat2
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    if fn(-100, os.fsencode(left), -100, os.fsencode(right), 2):
        raise Refusal('atomic checkout exchange unavailable')
    for parent in {left.parent, right.parent}:
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


class Native:
    def __init__(self):
        self.deadline = time.monotonic() + 200

    def recovery_budget(self):
        self.deadline = time.monotonic() + 80

    def call(self, argv, *, env=None):
        # No child body, exception text, env, token or secret hash is logged.
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Refusal('native transaction deadline exceeded')
        try:
            result = subprocess.run(argv, env=env or CLEAN_ENV, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True, timeout=min(180, remaining))
        except (OSError, subprocess.TimeoutExpired):
            raise Refusal('native action unavailable') from None
        if result.returncode:
            raise Refusal('native action refused')
        return result.stdout.strip()

    def head(self, path):
        value = self.call(['/usr/bin/git', '-C', str(path), 'rev-parse', 'HEAD'])
        if not SHA.fullmatch(value):
            raise Refusal('invalid checkout revision')
        return value

    def image(self, ref, optional=False):
        if optional:
            # Successful exact-reference listing proves absence; Docker errors
            # remain refusal and must never authorize bootstrap.
            rows = self.call(['/usr/bin/docker', 'image', 'ls', '--no-trunc',
                              '--format', '{{.ID}}', '--filter', 'reference=' + ref]).splitlines()
            if not rows:
                return None
            if len(rows) != 1 or not DIGEST.fullmatch(rows[0]):
                raise Refusal('ambiguous image observation')
            return rows[0]
        value = self.call(['/usr/bin/docker', 'image', 'inspect', '--format', '{{.Id}}', ref])
        if not DIGEST.fullmatch(value):
            raise Refusal('invalid image identity')
        return value

    def tag(self, image, tag):
        self.call(['/usr/bin/docker', 'tag', image, IMAGE + ':' + tag])

    def baseline(self, revision):
        value = self.call(['/usr/bin/docker', 'inspect', '--format',
                           '{{.Image}} {{.State.Running}} {{.State.Health.Status}}', CONTAINER]).split()
        if len(value) != 3 or not DIGEST.fullmatch(value[0]) or value[1:] != ['true', 'healthy']:
            raise Refusal('healthy installed baseline required')
        self.verify_image(value[0], revision)
        self.health(value[0], revision)
        return value[0]

    def verify_image(self, image, revision):
        actual = self.call(['/usr/bin/docker', 'image', 'inspect', '--format',
                            '{{index .Config.Labels "org.opencontainers.image.revision"}}', image])
        if actual != revision:
            raise Refusal('image revision mismatch')

    def health(self, image, revision):
        self.verify_image(image, revision)
        probe = "fetch('http://127.0.0.1:3600/health').then(async r=>{const b=await r.json();process.exit(r.ok&&b.status==='ok'?0:1)}).catch(()=>process.exit(1))"
        for _ in range(6):
            try:
                value = self.call(['/usr/bin/docker', 'inspect', '--format',
                                   '{{.Image}} {{.State.Running}} {{.State.Health.Status}}', CONTAINER])
                if value == image + ' true healthy':
                    self.call(['/usr/bin/docker', 'exec', CONTAINER, 'node', '-e', probe])
                    return
            except Refusal:
                pass
            time.sleep(2)
        raise Refusal('installed health not verified')

    def stage(self, path, revision, credential):
        env = dict(CLEAN_ENV)
        env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.extraHeader',
                   GIT_CONFIG_VALUE_0='AUTHORIZATION: basic ' +
                   base64.b64encode(('x-access-token:' + credential).encode()).decode())
        self.call(['/usr/bin/git', 'clone', '--quiet', '--no-checkout', REPO, str(path)], env=env)
        self.call(['/usr/bin/git', '-C', str(path), 'fetch', '--quiet', 'origin', 'main'], env=env)
        self.call(['/usr/bin/git', '-C', str(path), 'merge-base', '--is-ancestor', revision, 'origin/main'])
        self.call(['/usr/bin/git', '-C', str(path), 'checkout', '--quiet', '--detach', revision])

    def compose(self, path, revision, action):
        env = dict(CLEAN_ENV, BUILD_SHA=revision)
        args = ['/usr/bin/docker', 'compose', '--project-name', 'billing-arcana',
                '--env-file', str(path / '.env'), '-f', str(path / 'compose.deploy.yml')]
        args += ['build', 'billing'] if action == 'build' else ['up', '-d', '--no-build', '--no-deps', '--force-recreate', 'billing']
        self.call(args, env=env)


class Transaction:
    def __init__(self, root=STATE, env=ENV, native=None, uid=0, writer=atomic_state, swap=exchange):
        self.root, self.env, self.native = Path(root), Path(env), native or Native()
        self.uid, self.writer, self.swap = uid, writer, swap
        self.current = self.root / 'billing-arcana'
        self.private = self.root / '.billing-transactions'
        self.state = None

    def lock(self):
        protected(self.root, self.uid, directory=True)
        if not self.private.exists():
            self.private.mkdir(mode=0o700)
        protected(self.private, self.uid, directory=True, private=True)
        if self.private.stat().st_dev != self.root.stat().st_dev:
            raise Refusal('transaction mount boundary')
        fd = os.open(self.private / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        protected(self.private / 'lock', self.uid, private=True)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise Refusal('transaction already owned') from None
        return fd

    def persist(self, phase):
        self.state['phase'] = phase
        self.writer(self.private / 'active.json', self.state)

    def load(self):
        path = self.private / 'active.json'
        if not path.exists():
            return None
        protected(path, self.uid, private=True)
        data = json.loads(path.read_text())
        if data.get('schema') != 'BillingTransaction/v1' or not re.fullmatch(r'[0-9a-f]{32}', data.get('id', '')):
            raise Refusal('invalid protected journal')
        if (data.get('phase') not in ('build-intent', 'exchange-intent', 'up-intent', 'committed', 'rolled-back')
                or not all(isinstance(data.get(k), str) and SHA.fullmatch(data[k]) for k in ('old_sha', 'new_sha'))
                or not isinstance(data.get('image'), str) or not DIGEST.fullmatch(data['image'])
                or not all(type(data.get(k)) is int and data[k] > 0 for k in ('old_inode', 'new_inode'))
                or type(data.get('up_intent')) is not bool):
            raise Refusal('invalid protected journal fields')
        return data

    def rollback(self):
        s = self.state
        self.native.recovery_budget()
        backup = self.private / s['id'] / 'checkout'
        tree_safe(self.current, self.uid)
        tree_safe(backup, self.uid)
        if any(p.stat().st_dev != self.root.stat().st_dev for p in (self.current, backup)):
            raise Refusal('rollback mount boundary')
        pair = (self.current.stat().st_ino, backup.stat().st_ino)
        if pair == (s['new_inode'], s['old_inode']):
            self.swap(self.current, backup)
        elif pair != (s['old_inode'], s['new_inode']):
            raise Refusal('checkout custody changed; retain journal')
        # Restore the actual old live image, including a missing :latest baseline.
        self.native.tag(s['image'], 'latest')
        if s['up_intent']:
            self.native.compose(self.current, s['old_sha'], 'up')
            self.native.health(s['image'], s['old_sha'])
        self.persist('rolled-back')

    def check(self, revision):
        if not SHA.fullmatch(revision):
            raise Refusal('invalid revision')
        fd = self.lock()
        try:
            prior = self.load()
            if prior and prior['phase'] not in ('committed', 'rolled-back'):
                raise Refusal('unsettled transaction; explicit recovery required')
            tree_safe(self.current, self.uid)
            protected(self.current / '.env', self.uid, private=True)
            protected(self.env, self.uid, private=True)
            if self.current.stat().st_dev != self.root.stat().st_dev:
                raise Refusal('checkout mount boundary')
            old_sha = self.native.head(self.current)
            if old_sha == revision:
                raise Refusal('revision already installed; do not redeploy')
            image = self.native.baseline(old_sha)
            latest = self.native.image(IMAGE + ':latest', optional=True)
            if latest and latest != image:
                raise Refusal('latest is not installed baseline')
        finally:
            os.close(fd)

    def deploy(self, revision, credential):
        if not SHA.fullmatch(revision) or not re.fullmatch(r'[A-Za-z0-9_.-]{20,512}', credential):
            raise Refusal('invalid revision or stdin credential')
        fd = self.lock()
        try:
            prior = self.load()
            if prior and prior['phase'] not in ('committed', 'rolled-back'):
                raise Refusal('unsettled transaction; explicit recovery required')
            tree_safe(self.current, self.uid)
            protected(self.current / '.env', self.uid, private=True)
            env_stat = protected(self.env, self.uid, private=True)
            if self.current.stat().st_dev != self.root.stat().st_dev:
                raise Refusal('checkout mount boundary')
            old_sha = self.native.head(self.current)
            if old_sha == revision:
                raise Refusal('revision already installed; do not redeploy')
            image = self.native.baseline(old_sha)
            latest = self.native.image(IMAGE + ':latest', optional=True)
            if latest and latest != image:
                raise Refusal('latest is not installed baseline')
            # A missing latest never means first install: image/source/HTTP health
            # of the already installed service have just been proved.
            ident = uuid.uuid4().hex
            directory = self.private / ident
            directory.mkdir(mode=0o700)
            stage = directory / 'checkout'
            self.native.stage(stage, revision, credential)
            tree_safe(stage, self.uid)
            if self.native.head(stage) != revision:
                raise Refusal('staged revision mismatch')
            target = stage / '.env'
            if target.exists() or target.is_symlink():
                raise Refusal('tracked environment refuses protected installation')
            with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as dst:
                src = os.open(self.env, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    observed = os.fstat(src)
                    if (observed.st_dev, observed.st_ino, observed.st_mtime_ns, observed.st_size) != (env_stat.st_dev, env_stat.st_ino, env_stat.st_mtime_ns, env_stat.st_size):
                        raise Refusal('protected environment custody changed')
                    with os.fdopen(src, 'rb') as stream:
                        dst.write(stream.read())
                        final = os.fstat(stream.fileno())
                        if (final.st_mtime_ns, final.st_size, final.st_mode) != (observed.st_mtime_ns, observed.st_size, observed.st_mode):
                            raise Refusal('protected environment changed during staging')
                    dst.flush()
                    os.fsync(dst.fileno())
                except BaseException:
                    raise Refusal('protected environment staging failed') from None
            self.state = {'schema': 'BillingTransaction/v1', 'id': ident,
                          'old_sha': old_sha, 'new_sha': revision, 'image': image,
                          'old_inode': self.current.stat().st_ino, 'new_inode': stage.stat().st_ino,
                          'up_intent': False}
            self.persist('build-intent')
            try:
                self.native.tag(image, 'previous')
                self.native.compose(stage, revision, 'build')
                candidate = self.native.image(IMAGE + ':latest')
                self.native.verify_image(candidate, revision)
                self.persist('exchange-intent')
                self.swap(self.current, stage)
                self.state['up_intent'] = True
                try:
                    self.persist('up-intent')
                except OSError:
                    self.state['up_intent'] = False
                    raise
                self.native.compose(self.current, revision, 'up')
                self.native.health(candidate, revision)
                self.native.tag(candidate, revision)
                self.persist('committed')
            except (Refusal, OSError, ValueError, KeyboardInterrupt):
                try:
                    self.rollback()
                except (Refusal, OSError, ValueError):
                    raise Refusal('transaction failed; protected recovery journal retained') from None
                raise Refusal('transaction failed; baseline restored') from None
            return ident
        finally:
            os.close(fd)

    def recover(self, ident):
        fd = self.lock()
        try:
            self.state = self.load()
            if not self.state or self.state['id'] != ident or self.state['phase'] == 'rolled-back':
                raise Refusal('recovery receipt does not match active transaction')
            self.rollback()
        finally:
            os.close(fd)


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) != 3:
        raise Refusal('root transaction entrypoint required')
    action, value = sys.argv[1:]
    if action == 'check' and SHA.fullmatch(value):
        Transaction().check(value)
        print('BILLING_TRANSACTION_BASELINE_PASS')
    elif action == 'deploy' and SHA.fullmatch(value):
        # Bound input; malformed or expired GitHub credentials fail native fetch.
        signal.alarm(10)
        credential = sys.stdin.readline(514).rstrip('\n')
        signal.alarm(0)
        ident = Transaction().deploy(value, credential)
        print('BILLING_TRANSACTION_PASS id=' + ident)
    elif action == 'recover' and re.fullmatch(r'[0-9a-f]{32}', value):
        Transaction().recover(value)
        print('BILLING_TRANSACTION_ROLLBACK_PASS id=' + value)
    else:
        raise Refusal('invalid transaction action')

if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, AttributeError, KeyboardInterrupt):
        print('BILLING_TRANSACTION_REFUSED; protected journal retained where created', file=sys.stderr)
        sys.exit(1)
