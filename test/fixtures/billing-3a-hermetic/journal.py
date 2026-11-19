"""Owned-directory source journal. No transport, authentic identity or send permit.

Completed fsync calls and source history are observable; physical power-loss
durability, trusted restart heads and native accounting remain NOT_MEASURED.
"""
from contextlib import contextmanager
import errno
import fcntl
import os
from pathlib import Path
import re
import stat

import accounting as a
from instrument import Refused, require


DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
MAX_BYTES = 16 * 1024
MAX_EVENTS = 3 * a.CAPS[0]
EVENT_NAME = re.compile(r'event-([0-9]{6})\.json')


def owned(info, mode):
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
            stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1,
            'journal_file_custody')


def write_all(fd, raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_BYTES, 'journal_size')
    done = 0
    while done < len(raw):
        try:
            count = os.write(fd, raw[done:])
        except InterruptedError:
            continue
        require(type(count) is int and 0 < count <= len(raw) - done,
                'journal_short_write')
        done += count


def ancestor(info):
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.geteuid()),
            'journal_ancestor_custody')
    writable = stat.S_IMODE(info.st_mode) & 0o022
    require(not writable or (info.st_uid == 0 and info.st_mode & stat.S_ISVTX),
            'journal_writable_ancestor')


def open_directory(path):
    path = Path(path)
    require(path.is_absolute() and len(path.parts) > 1 and
            '..' not in path.parts, 'journal_directory_path')
    parent = os.open('/', DIR_FLAGS)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, DIR_FLAGS, dir_fd=parent)
            try:
                ancestor(os.fstat(child))
            except BaseException:
                os.close(child)
                raise
            os.close(parent)
            parent = child
        root = os.open(path.name, DIR_FLAGS, dir_fd=parent)
        try:
            info = os.fstat(root)
            require(info.st_uid == os.geteuid() and
                    stat.S_IMODE(info.st_mode) == 0o700, 'journal_directory_custody')
        except BaseException:
            os.close(root)
            raise
        return root, parent, path.name
    except BaseException:
        os.close(parent)
        raise


class Journal:
    def __init__(self, path, *, monetary_verifier=None, clock=None):
        self.monetary_verifier = monetary_verifier
        self.clock = clock
        try:
            self.root, self.parent, self.name = open_directory(path)
        except OSError:
            raise Refused('journal_directory_unavailable') from None
        self.closed = False

    def close(self):
        if not self.closed:
            os.close(self.root)
            os.close(self.parent)
            self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *ignored):
        self.close()

    def _anchor(self):
        require(not self.closed, 'journal_closed')
        current = os.fstat(self.root)
        named = os.stat(self.name, dir_fd=self.parent, follow_symlinks=False)
        require(stat.S_ISDIR(named.st_mode) and
                (current.st_dev, current.st_ino) == (named.st_dev, named.st_ino) and
                current.st_uid == os.geteuid() and
                stat.S_IMODE(current.st_mode) == 0o700, 'journal_anchor_changed')

    def _names(self):
        names = os.listdir(self.root)
        require(len(names) <= MAX_EVENTS + 2 and all(
            name in ('journal.lock', 'baseline.json') or EVENT_NAME.fullmatch(name)
            for name in names), 'journal_unexpected_entry')
        return names

    @contextmanager
    def _locked(self):
        fd = None
        try:
            self._anchor()
            self._names()  # Refuse unrelated directories before creating a lock.
            fd = os.open('journal.lock', os.O_RDWR | os.O_CREAT | FILE_FLAGS,
                         0o600, dir_fd=self.root)
            owned(os.fstat(fd), 0o600)
            require(os.fstat(fd).st_size == 0, 'journal_lock_content')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            named = os.stat('journal.lock', dir_fd=self.root, follow_symlinks=False)
            opened = os.fstat(fd)
            require((named.st_dev, named.st_ino) == (opened.st_dev, opened.st_ino),
                    'journal_lock_replaced')
            os.fsync(fd)
            os.fsync(self.root)
            yield
            self._anchor()
            named = os.stat('journal.lock', dir_fd=self.root, follow_symlinks=False)
            require((named.st_dev, named.st_ino) == (opened.st_dev, opened.st_ino),
                    'journal_lock_replaced')
        except OSError as error:
            reason = 'journal_busy' if error.errno in (errno.EAGAIN, errno.EACCES) else 'journal_io_failed'
            raise Refused(reason) from None
        finally:
            if fd is not None:
                os.close(fd)

    def _read(self, name):
        fd = os.open(name, os.O_RDONLY | FILE_FLAGS, dir_fd=self.root)
        try:
            info = os.fstat(fd)
            owned(info, 0o400)
            require(0 < info.st_size <= MAX_BYTES, 'journal_size')
            raw = bytearray()
            while len(raw) <= MAX_BYTES:
                chunk = os.read(fd, min(4096, MAX_BYTES + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            require(len(raw) == info.st_size and len(raw) <= MAX_BYTES,
                    'journal_read_changed')
            end = os.fstat(fd)
            require((info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
                    (end.st_size, end.st_mtime_ns, end.st_ctime_ns),
                    'journal_read_changed')
            return bytes(raw)
        finally:
            os.close(fd)

    def _publish(self, name, raw):
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | FILE_FLAGS,
                     0o600, dir_fd=self.root)
        try:
            owned(os.fstat(fd), 0o600)
            write_all(fd, raw)
            os.fchmod(fd, 0o400)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self.root)
        self._anchor()
        # Failed/partial files are deliberately retained, never erased or reset.

    def _load(self):
        names = self._names()
        require('baseline.json' in names, 'journal_baseline_missing')
        seed_raw = self._read('baseline.json')
        doc = a.strict_json(seed_raw)
        require(isinstance(doc, dict) and doc.get('events') == [] and
                isinstance(doc.get('baseline'), list), 'journal_baseline_shape')
        seed = a.initial(doc.get('scope'), tuple(doc.get('baseline', [])),
                         doc.get('baseline_reference'))
        seed = a.restore(seed_raw, a.fold(seed)[1])
        files = sorted(name for name in names if EVENT_NAME.fullmatch(name))
        require(files == [f'event-{n:06d}.json' for n in range(1, len(files) + 1)],
                'journal_event_gap')
        ledger = a.Ledger(seed.scope_sha256, seed.baseline, seed.baseline_reference,
                          tuple(self._read(name) for name in files))
        a.fold(ledger)
        return ledger

    def _expected(self, expected_head):
        a.reference(expected_head)
        ledger = self._load()
        require(a.fold(ledger)[1] == expected_head, 'journal_stale_head')
        return ledger

    def initialize(self, seed):
        a.fold(seed)
        require(seed.events == (), 'journal_nonempty_seed')
        with self._locked():
            require(set(self._names()) == {'journal.lock'}, 'journal_already_initialized')
            os.fsync(self.parent)  # Persist the supplied initial directory entry.
            self._publish('baseline.json', a.snapshot(seed))
            return self._observation(seed, 1)

    def read(self, expected_head):
        with self._locked():
            return self._expected(expected_head)

    def transact(self, expected_head, operation, *args):
        require(type(operation) is str and operation in ('reserve', 'reserve_money', 'intent', 'unknown', 'reconcile'),
                'journal_operation')
        with self._locked():
            old = self._expected(expected_head)
            if operation == 'reserve_money':
                require(len(args) == 4, 'money_operation_arguments')
                new = a.reserve_money(old, *args, verify=self.monetary_verifier,
                                      now=self.clock() if self.clock else None)
            else:
                new = getattr(a, operation)(old, *args)
            require(new.events[:len(old.events)] == old.events and
                    len(new.events) <= len(old.events) + 1, 'journal_transition_shape')
            if new.events != old.events:
                self._publish(f'event-{len(new.events):06d}.json', new.events[-1])
            return self._observation(new, len(new.events) - len(old.events))

    def recover(self, expected_head):
        with self._locked():
            ledger = self._expected(expected_head)
            before = len(ledger.events)
            attempts, _ = a.fold(ledger)
            for ident, item in attempts.items():
                if item.phase in ('RESERVED', 'FORWARD_INTENT'):
                    ledger = a.unknown(ledger, ident)
                    self._publish(f'event-{len(ledger.events):06d}.json', ledger.events[-1])
            return self._observation(ledger, len(ledger.events) - before)

    def _observation(self, ledger, publications=0):
        row = a.observe(ledger)
        row.update(schema='SourceJournalObservation/v1',
                   source_publications_completed=publications,
                   source_publication_order='write_all,file_fsync,directory_fsync',
                   physical_power_loss_durability='NOT_MEASURED',
                   trusted_restart_head='NOT_MEASURED', cooperative_lock_only=True,
                   native_send_binding=False, service_identity_authenticated=False)
        return row
