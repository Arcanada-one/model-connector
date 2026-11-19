"""Owned synthetic temporary files only; no native/model/network execution."""
import errno
import fcntl
import multiprocessing
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import accounting as a
import journal as j
from instrument import Refused


def seed(baseline=(180, 0, 0)):
    return a.initial('1' * 64, baseline, '2' * 64)


def request():
    return a.encoded({'model': 'synthetic', 'max_output_tokens': 10,
                      'input': [{'type': 'message', 'content': 'synthetic'}]})


def reserve_args(ident='one'):
    return ident, request(), 20, 10, '3' * 64


def contender(path, head, ident, ready, start, results):
    ready.put(True)
    start.wait(10)
    try:
        with j.Journal(path) as store:
            row = store.transact(head, 'reserve', *reserve_args(ident))
        results.put(('accepted', row['source_charged']))
    except Refused as error:
        results.put(('refused', str(error)))


class JournalSource(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bench-journal-synthetic-')
        self.path = Path(self.temp.name)/'store'
        self.path.mkdir(mode=0o700)
        self.store = j.Journal(self.path)
        self.row = self.store.initialize(seed())
        self.head = self.row['head_sha256']

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def reserve(self, ident='one', head=None):
        row = self.store.transact(self.head if head is None else head,
                                  'reserve', *reserve_args(ident))
        self.head = row['head_sha256']
        return row

    def test_baseline_is_exclusive_and_readonly(self):
        with self.assertRaisesRegex(Refused, 'already_initialized'):
            self.store.initialize(seed())
        self.assertEqual(stat.S_IMODE((self.path/'baseline.json').stat().st_mode), 0o400)
        self.assertEqual(a.fold(self.store.read(self.head))[1], self.head)

    def test_real_reopen_preserves_reserved_liability(self):
        row = self.reserve()
        with j.Journal(self.path) as reopened:
            self.assertEqual(a.observe(reopened.read(self.head))['source_charged'], (181, 20, 10))
        self.assertEqual(row['source_publications_completed'], 1)

    def test_intent_requires_durable_reserved_prefix(self):
        with self.assertRaisesRegex(Refused, 'attempt_missing'):
            self.store.transact(self.head, 'intent', 'one')
        self.reserve()
        row = self.store.transact(self.head, 'intent', 'one')
        self.assertEqual(row['source_charged'], (181, 20, 10))
        self.assertEqual(len(list(self.path.glob('event-*'))), 2)

    def test_reservation_file_and_directory_sync_precede_intent_write(self):
        trace = []; write = os.write; sync = os.fsync
        def record_write(fd, data):
            trace.append(('write', os.fstat(fd).st_ino)); return write(fd, data)
        def record_sync(fd):
            trace.append(('sync', os.fstat(fd).st_ino)); return sync(fd)
        root = os.fstat(self.store.root).st_ino
        with mock.patch.object(j.os, 'write', side_effect=record_write), mock.patch.object(j.os, 'fsync', side_effect=record_sync):
            self.reserve(); before_intent = len(trace)
            self.assertEqual(trace[-1], ('sync', root))
            self.store.transact(self.head, 'intent', 'one')
        reserve_inode = (self.path/'event-000001.json').stat().st_ino
        intent_inode = (self.path/'event-000002.json').stat().st_ino
        self.assertLess(trace.index(('write', reserve_inode)), trace.index(('sync', reserve_inode)))
        self.assertLess(trace.index(('sync', reserve_inode)), before_intent)
        self.assertGreaterEqual(trace.index(('write', intent_inode)), before_intent)
        self.assertLess(trace.index(('write', intent_inode)), trace.index(('sync', intent_inode)))
        self.assertEqual(trace[-1], ('sync', root))

    def test_completed_calls_never_refund_attempt(self):
        self.reserve()
        row = self.store.transact(self.head, 'intent', 'one')
        row = self.store.transact(row['head_sha256'], 'reconcile', 'one', 2, 3, '4'*64)
        self.assertEqual(row['source_charged'], (181, 2, 3))

    def test_unknown_recovery_holds_all_reserved_and_intended(self):
        self.reserve('one'); self.reserve('two')
        row = self.store.transact(self.head, 'intent', 'one')
        recovered = self.store.recover(row['head_sha256'])
        self.assertEqual(recovered['source_charged'], (182, 40, 20))
        self.assertEqual(recovered['unknown_usage'], 2)
        self.assertEqual(recovered['source_publications_completed'], 2)
        with self.assertRaisesRegex(Refused, 'unknown_usage_fence'):
            self.store.transact(recovered['head_sha256'], 'reserve', *reserve_args('three'))
        with self.assertRaisesRegex(Refused, 'reconcile_transition'):
            self.store.transact(recovered['head_sha256'], 'reconcile', 'one', 0, 0, '4'*64)

    def test_recovery_replay_is_no_publication_or_send_permit(self):
        self.reserve(); row = self.store.recover(self.head)
        replay = self.store.recover(row['head_sha256'])
        self.assertEqual(replay['source_publications_completed'], 0)
        self.assertFalse(replay['native_send_binding'])

    def test_exact_data_replay_appends_nothing(self):
        self.reserve(); count = len(list(self.path.iterdir()))
        row = self.store.transact(self.head, 'reserve', *reserve_args())
        self.assertEqual(len(list(self.path.iterdir())), count)
        self.assertEqual(row['source_publications_completed'], 0)

    def test_stale_writer_cannot_append(self):
        old = self.head; self.reserve()
        with self.assertRaisesRegex(Refused, 'stale_head'):
            self.store.transact(old, 'reserve', *reserve_args('two'))
        self.assertEqual(len(list(self.path.glob('event-*'))), 1)

    def test_cap_refusal_writes_no_new_event(self):
        other = self.path/'other'; other.mkdir(mode=0o700)
        with j.Journal(other) as store:
            row = store.initialize(seed((527, 0, 0)))
            row = store.transact(row['head_sha256'], 'reserve', *reserve_args())
            with self.assertRaisesRegex(Refused, 'cap_exceeded'):
                store.transact(row['head_sha256'], 'reserve', *reserve_args('two'))
            self.assertEqual(len(list(other.glob('event-*'))), 1)

    def test_missing_provider_cap_refuses_before_write(self):
        with self.assertRaisesRegex(Refused, 'request_output_cap'):
            self.store.transact(self.head, 'reserve', 'one', a.encoded({'input': []}), 20, 10, '3'*64)
        self.assertEqual(len(list(self.path.glob('event-*'))), 0)

    def test_observations_never_authenticate_or_admit_runtime(self):
        for row in (self.row, self.reserve()):
            for key in ('runtime_authorized', 'accounting_admitted', 'references_authenticated',
                        'native_send_binding', 'service_identity_authenticated'):
                self.assertFalse(row[key])
            for key in ('durability', 'actual_upstream_accounting', 'physical_power_loss_durability',
                        'trusted_restart_head'):
                self.assertEqual(row[key], 'NOT_MEASURED')
            self.assertTrue(row['cooperative_lock_only'])
            self.assertEqual(row['model_calls'], 0)

    def test_partial_writes_and_eintr_write_full_valid_event(self):
        real = os.write; calls = []
        def partial(fd, data):
            calls.append(len(data))
            if len(calls) == 1:
                raise InterruptedError()
            return real(fd, data[:7])
        with mock.patch.object(j.os, 'write', side_effect=partial):
            row = self.reserve()
        self.assertGreater(len(calls), 2)
        self.assertEqual(a.fold(self.store.read(row['head_sha256']))[1], row['head_sha256'])

    def test_zero_write_refuses_and_preserves_failed_prefix(self):
        with mock.patch.object(j.os, 'write', return_value=0):
            with self.assertRaisesRegex(Refused, 'short_write'):
                self.reserve()
        self.assertTrue((self.path/'event-000001.json').exists())
        with self.assertRaisesRegex(Refused, 'journal_file_custody|journal_size'):
            self.store.read(self.head)

    def test_partial_enospc_never_acks_or_deletes_ambiguous_file(self):
        real = os.write; calls = []
        def fail(fd, data):
            calls.append(1)
            if len(calls) == 1:
                return real(fd, data[:3])
            raise OSError(errno.ENOSPC, 'synthetic')
        with mock.patch.object(j.os, 'write', side_effect=fail):
            with self.assertRaisesRegex(Refused, 'io_failed'):
                self.reserve()
        self.assertEqual((self.path/'event-000001.json').stat().st_size, 3)
        with self.assertRaises(Refused):
            self.store.recover(self.head)

    def test_each_fsync_failure_refuses_no_future_intent(self):
        for point in range(1, 5):
            with self.subTest(point=point), tempfile.TemporaryDirectory(prefix='bench-journal-fault-') as directory:
                with j.Journal(directory) as store:
                    row = store.initialize(seed()); real = os.fsync; calls = []
                    def fail(fd):
                        calls.append(fd)
                        if len(calls) == point:
                            raise OSError(errno.EIO, 'synthetic')
                        return real(fd)
                    with mock.patch.object(j.os, 'fsync', side_effect=fail):
                        with self.assertRaisesRegex(Refused, 'io_failed'):
                            store.transact(row['head_sha256'], 'reserve', *reserve_args())
                    if point >= 3:
                        self.assertTrue((Path(directory)/'event-000001.json').exists())
                        with self.assertRaises(Refused):
                            store.transact(row['head_sha256'], 'intent', 'one')
                    else:
                        self.assertFalse((Path(directory)/'event-000001.json').exists())

    def test_initial_parent_and_baseline_fsync_are_real_and_ordered(self):
        with tempfile.TemporaryDirectory(prefix='bench-journal-order-') as directory:
            with j.Journal(directory) as store:
                trace = []; write = os.write; sync = os.fsync
                def record_write(fd, data):
                    trace.append(('write', os.fstat(fd).st_ino)); return write(fd, data)
                def record_sync(fd):
                    trace.append(('sync', os.fstat(fd).st_ino)); return sync(fd)
                parent = os.fstat(store.parent).st_ino; root = os.fstat(store.root).st_ino
                with mock.patch.object(j.os, 'write', side_effect=record_write), mock.patch.object(j.os, 'fsync', side_effect=record_sync):
                    store.initialize(seed())
                inode = (Path(directory)/'baseline.json').stat().st_ino
                self.assertIn(('sync', parent), trace)
                self.assertIn(('sync', inode), trace)
                self.assertLess(trace.index(('sync', parent)), trace.index(('write', inode)))
                self.assertLess(trace.index(('write', inode)), trace.index(('sync', inode)))
                self.assertEqual(trace[-1], ('sync', root))

    def test_failed_initial_parent_sync_never_creates_baseline(self):
        with tempfile.TemporaryDirectory(prefix='bench-journal-parent-') as directory:
            with j.Journal(directory) as store:
                real = os.fsync; parent = store.parent
                def fail(fd):
                    if fd == parent: raise OSError(errno.EIO, 'synthetic')
                    return real(fd)
                with mock.patch.object(j.os, 'fsync', side_effect=fail):
                    with self.assertRaisesRegex(Refused, 'io_failed'):
                        store.initialize(seed())
                self.assertFalse((Path(directory)/'baseline.json').exists())

    def test_crash_prefixes_reopen_only_with_matching_head(self):
        rows = [self.row, self.reserve()]
        rows.append(self.store.transact(self.head, 'intent', 'one'))
        for row in rows[:-1]:
            with self.assertRaisesRegex(Refused, 'stale_head'):
                self.store.read(row['head_sha256'])
        row = self.store.recover(rows[-1]['head_sha256'])
        self.assertEqual(row['source_charged'], (181, 20, 10))
        self.assertEqual(row['unknown_usage'], 1)

    def test_malformed_or_missing_tail_never_auto_repaired(self):
        self.reserve(); second = self.store.transact(self.head, 'intent', 'one')
        tail = self.path/'event-000002.json'; tail.chmod(0o600); tail.write_bytes(b'{'); tail.chmod(0o400)
        with self.assertRaises(Refused): self.store.recover(second['head_sha256'])
        self.assertEqual(tail.read_bytes(), b'{')
        tail.unlink()
        with self.assertRaisesRegex(Refused, 'stale_head'):
            self.store.read(second['head_sha256'])

    def test_event_sequence_gap_refuses(self):
        self.reserve(); (self.path/'event-000001.json').rename(self.path/'event-000003.json')
        with self.assertRaisesRegex(Refused, 'event_gap'):
            self.store.read(self.head)

    def test_symlink_record_never_read(self):
        self.reserve(); target = self.path/'event-000001.json'; target.unlink()
        target.symlink_to('/nonexistent-synthetic-reference')
        with self.assertRaisesRegex(Refused, 'io_failed'):
            self.store.read(self.head)

    def test_hardlink_record_never_read(self):
        self.reserve(); os.link(self.path/'event-000001.json', self.path/'linked.json')
        (self.path/'linked.json').rename(self.path.parent/(self.path.name+'-synthetic-link'))
        link = self.path.parent/(self.path.name+'-synthetic-link')
        try:
            with self.assertRaisesRegex(Refused, 'file_custody'):
                self.store.read(self.head)
        finally:
            link.unlink()

    def test_fifo_record_refuses_without_blocking(self):
        self.reserve(); target = self.path/'event-000001.json'; target.unlink(); os.mkfifo(target, 0o400)
        with self.assertRaisesRegex(Refused, 'file_custody'):
            self.store.read(self.head)

    def test_writable_record_refuses(self):
        self.reserve(); (self.path/'event-000001.json').chmod(0o600)
        with self.assertRaisesRegex(Refused, 'file_custody'):
            self.store.read(self.head)

    def test_wrong_record_owner_refuses_before_content_read(self):
        self.reserve()
        info = (self.path/'event-000001.json').stat()
        wrong = SimpleNamespace(st_mode=info.st_mode, st_uid=os.geteuid()+1,
                                st_nlink=1, st_size=info.st_size,
                                st_mtime_ns=info.st_mtime_ns, st_ctime_ns=info.st_ctime_ns)
        with mock.patch.object(j.os, 'fstat', return_value=wrong), mock.patch.object(j.os, 'read', wraps=os.read) as read:
            with self.assertRaisesRegex(Refused, 'file_custody'):
                self.store._read('event-000001.json')
            read.assert_not_called()

    def test_oversized_record_refuses_before_content_read(self):
        self.reserve(); target = self.path/'event-000001.json'
        target.chmod(0o600); target.write_bytes(b'x'*(j.MAX_BYTES+1)); target.chmod(0o400)
        with mock.patch.object(j.os, 'read') as read:
            with self.assertRaisesRegex(Refused, 'journal_size'):
                self.store._read(target.name)
            read.assert_not_called()

    def test_baseline_caps_and_false_runtime_fields_refuse(self):
        import json
        target = self.path/'baseline.json'; original = target.read_bytes()
        for change in ({'caps': [529, 10000000, 1500000]}, {'runtime_authorized': True}, {'baseline': None}):
            with self.subTest(change=change):
                doc = json.loads(original); doc.update(change)
                target.chmod(0o600); target.write_bytes(a.encoded(doc)); target.chmod(0o400)
                with self.assertRaises(Refused): self.store.read(self.head)

    def test_nonempty_seed_refuses_before_lock_or_reset(self):
        with tempfile.TemporaryDirectory(prefix='bench-journal-nonempty-') as directory:
            value = a.reserve(seed(), *reserve_args())
            with j.Journal(directory) as store:
                with self.assertRaisesRegex(Refused, 'nonempty_seed'):
                    store.initialize(value)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_wrong_directory_owner_fails_even_with_same_inode(self):
        info = os.fstat(self.store.root)
        wrong = SimpleNamespace(st_mode=info.st_mode, st_uid=os.geteuid()+1,
                                st_dev=info.st_dev, st_ino=info.st_ino)
        with mock.patch.object(j.os, 'fstat', return_value=wrong):
            with self.assertRaisesRegex(Refused, 'anchor_changed'):
                self.store._anchor()

    def test_unrelated_directory_refuses_before_lock_creation(self):
        with tempfile.TemporaryDirectory(prefix='bench-journal-unrelated-') as directory:
            path = Path(directory); (path/'unrelated.txt').write_text('synthetic')
            with j.Journal(path) as store, self.assertRaisesRegex(Refused, 'unexpected_entry'):
                store.initialize(seed())
            self.assertFalse((path/'journal.lock').exists())

    def test_root_symlink_and_writable_root_refuse(self):
        link = self.path.parent/(self.path.name+'-synthetic-link'); link.symlink_to(self.path)
        try:
            with self.assertRaises(Refused): j.Journal(link)
        finally: link.unlink()
        self.path.chmod(0o755)
        try:
            with self.assertRaisesRegex(Refused, 'directory_custody'): j.Journal(self.path)
        finally: self.path.chmod(0o700)

    def test_ancestor_symlink_and_writable_ancestor_refuse(self):
        parent = self.path/'parent'; parent.mkdir(mode=0o700); child = parent/'child'; child.mkdir(mode=0o700)
        link = self.path/'alias'; link.symlink_to(parent)
        with self.assertRaises(Refused): j.Journal(link/'child')
        parent.chmod(0o777)
        with self.assertRaisesRegex(Refused, 'writable_ancestor'): j.Journal(child)

    def test_root_rename_cannot_redirect_anchored_store(self):
        old = self.path.parent/(self.path.name+'-synthetic-moved'); self.path.rename(old); self.path.mkdir(mode=0o700)
        try:
            with self.assertRaisesRegex(Refused, 'anchor_changed'):
                self.reserve()
        finally:
            self.path.rmdir(); old.rename(self.path)

    def test_lock_content_and_replacement_refuse(self):
        lock = self.path/'journal.lock'; lock.write_bytes(b'synthetic')
        with self.assertRaisesRegex(Refused, 'lock_content'): self.reserve()
        lock.write_bytes(b'')
        with self.assertRaisesRegex(Refused, 'lock_replaced'):
            with self.store._locked():
                lock.unlink(); lock.touch(mode=0o600)

    def test_busy_lock_refuses_without_wait_or_write(self):
        fd = os.open(self.path/'journal.lock', os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(Refused, 'journal_busy'): self.reserve()
        finally: os.close(fd)
        self.assertFalse((self.path/'event-000001.json').exists())

    def test_real_cooperating_process_race_has_one_winner(self):
        ctx = multiprocessing.get_context('fork'); ready = ctx.Queue(); results = ctx.Queue(); start = ctx.Event()
        processes = [ctx.Process(target=contender, args=(str(self.path), self.head, str(n), ready, start, results)) for n in range(2)]
        for process in processes: process.start()
        try:
            for _ in processes: ready.get(timeout=10)
            start.set(); rows = [results.get(timeout=10) for _ in processes]
            self.assertEqual(sum(row[0]=='accepted' for row in rows), 1)
            self.assertEqual(sum(row[0]=='refused' for row in rows), 1)
            self.assertEqual(len(list(self.path.glob('event-*'))), 1)
        finally:
            start.set()
            for process in processes:
                process.join(10)
                if process.is_alive(): process.terminate(); process.join(5)
            for process in processes: self.assertEqual(process.exitcode, 0)
            ready.close(); results.close()

    def test_closed_journal_and_unknown_operation_refuse(self):
        with self.assertRaisesRegex(Refused, 'operation'):
            self.store.transact(self.head, 'reset')
        self.store.close()
        with self.assertRaisesRegex(Refused, 'closed'):
            self.store.read(self.head)


if __name__ == '__main__':
    unittest.main()
