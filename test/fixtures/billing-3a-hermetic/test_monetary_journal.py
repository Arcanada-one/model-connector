"""Real source Journal paths; synthetic receipts, no production/native authority."""
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import accounting as a
import journal as j
import monetary as m
from instrument import Refused
from test_monetary import Fixture


def setup_fixture(head):
    f = Fixture()
    f.wire = a.encoded({'model': 'synthetic-model', 'max_output_tokens': 2,
                        'input': [{'type': 'message', 'content': 'whole synthetic request'}]})
    for obj in (f.request, f.policy, f.bounds): obj['campaign'] = '1'*64
    f.policy['baseline_head'] = head
    f.policy['money_cap'] = 10
    f.bounds['wire_sha256'] = m.digest(f.wire)
    f.request['wire_sha256'] = m.digest(f.wire)
    f.refresh()
    return f


def contend(path, head, ready, start, results, ident):
    f = setup_fixture(head); f.request['attempt'] = ident; f.request['nonce'] = ident
    ready.put(True); start.wait(5)
    try:
        with j.Journal(path, monetary_verifier=f.args()['verify'], clock=lambda: 20) as store:
            row = store.transact(head, 'reserve_money', f.request, f.wire, f.policy_raw, f.bounds_raw)
        results.put(('accepted', row['source_money']['charged']))
    except (Refused, m.Refused) as error: results.put(('refused', str(error)))


class MonetaryJournal(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='money-journal-')
        self.path = Path(self.temp.name)/'store'; self.path.mkdir(mode=0o700)
        self.store = j.Journal(self.path)
        self.head = self.store.initialize(a.initial('1'*64, m.FLOOR, '2'*64))['head_sha256']
        self.f = setup_fixture(self.head)
        self.store.monetary_verifier = self.f.args()['verify']; self.store.clock = lambda: 20

    def tearDown(self): self.store.close(); self.temp.cleanup()

    def reserve(self):
        f=self.f
        return self.store.transact(self.head, 'reserve_money', f.request, f.wire, f.policy_raw, f.bounds_raw)

    def test_one_atomic_event_reopens_both_reserves(self):
        row = self.reserve(); self.assertFalse(row['can_send'])
        self.assertEqual(row['source_money']['charged'], 10)
        self.assertEqual(row['source_charged'], (181, m.FLOOR[1]+4, m.FLOOR[2]+2))
        self.assertEqual(len(list(self.path.glob('event-*'))), 1)
        with j.Journal(self.path) as reopened:
            restored = a.observe(reopened.read(row['head_sha256']))
        self.assertEqual(restored['source_money'], row['source_money'])
        self.assertEqual(restored['source_charged'], row['source_charged'])

    def hard_maximum(self):
        raw = a.strict_json(self.f.wire); del raw['max_output_tokens']
        self.f.wire = a.encoded(raw)
        for row in (self.f.request, self.f.bounds): row['wire_sha256'] = m.digest(self.f.wire)
        self.f.bounds['output_enforcement'] = 'verified_native_hard_maximum'
        self.f.refresh()

    def test_hard_maximum_requires_authentic_exact_scope_wire_and_policy(self):
        for defect in ('missing', 'forged', 'expired', 'wire', 'model', 'account',
                       'policy', 'digest', 'zero_output', 'incomplete_billable'):
            with self.subTest(defect=defect):
                self.f = setup_fixture(self.head); self.hard_maximum()
                self.store.monetary_verifier = self.f.args()['verify']
                if defect == 'missing': self.store.monetary_verifier = None
                elif defect == 'forged':
                    self.f.bounds['context_limit'] += 1
                    self.f.bounds_raw = a.encoded(self.f.bounds)
                    self.f.request['bounds_sha256'] = m.digest(self.f.bounds_raw)
                elif defect == 'expired': self.f.bounds['expires'] = 20; self.f.refresh()
                elif defect == 'wire': self.f.bounds['wire_sha256'] = 'f'*64; self.f.refresh()
                elif defect in ('model', 'account'):
                    self.f.bounds[defect] = 'substituted'; self.f.refresh()
                elif defect == 'policy': self.f.policy['model'] = 'substituted'; self.f.refresh()
                elif defect == 'digest': self.f.request['bounds_sha256'] = 'f'*64
                elif defect == 'zero_output': self.f.bounds['output_upper'] = 0; self.f.refresh()
                elif defect == 'incomplete_billable': self.f.bounds['all_billable_units'] = False; self.f.refresh()
                with self.assertRaises((Refused, m.Refused)): self.reserve()
                self.assertEqual(self.store._load().events, ())

    def test_present_output_limiter_must_still_match_for_both_policies(self):
        for enforcement in ('verified_native_limiter', 'verified_native_hard_maximum'):
            for value in (None, True, 0, 1, 3, '2'):
                with self.subTest(enforcement=enforcement, value=value):
                    self.f = setup_fixture(self.head)
                    raw = a.strict_json(self.f.wire); raw['max_output_tokens'] = value
                    self.f.wire = a.encoded(raw)
                    for row in (self.f.request, self.f.bounds): row['wire_sha256'] = m.digest(self.f.wire)
                    self.f.bounds['output_enforcement'] = enforcement; self.f.refresh()
                    self.store.monetary_verifier = self.f.args()['verify']
                    with self.assertRaisesRegex(Refused, 'request_output_cap_missing_or_mismatched'):
                        self.reserve()
                    self.assertEqual(self.store._load().events, ())

    def test_missing_auth_and_bad_bound_publish_nothing(self):
        self.store.monetary_verifier = None
        with self.assertRaises(m.Refused): self.reserve()
        self.assertEqual(list(self.path.glob('event-*')), [])
        self.store.monetary_verifier = self.f.args()['verify']
        self.f.bounds['output_enforcement'] = 'declared_only'; self.f.refresh()
        with self.assertRaises(m.Refused): self.reserve()
        self.assertEqual(list(self.path.glob('event-*')), [])

    def test_no_dollar_widening_or_new_baseline(self):
        self.f.policy['money_cap'] = self.f.policy['scale']+1; self.f.refresh()
        with self.assertRaises(m.Refused): self.reserve()
        self.f = setup_fixture(self.head); self.store.monetary_verifier = self.f.args()['verify']
        self.f.policy['baseline_head'] = 'f'*64; self.f.refresh()
        with self.assertRaises(Refused): self.reserve()
        self.assertEqual(list(self.path.glob('event-*')), [])

    def test_money_cap_replay_legacy_bypass_and_unknown_recovery(self):
        row = self.reserve(); self.head = row['head_sha256']
        with self.assertRaises(m.Refused): self.reserve()
        self.f.request['attempt'] = 'a2'; self.f.request['nonce'] = 'n2'
        with self.assertRaisesRegex(m.Refused, 'money_cap'): self.reserve()
        with self.assertRaisesRegex(Refused, 'money_projection_required'):
            self.store.transact(self.head, 'reserve', 'bypass', self.f.wire, 4, 2, 'd'*64)
        recovered = self.store.recover(self.head)
        self.assertEqual(recovered['source_money']['charged'], 10)
        self.assertEqual(recovered['source_charged'], row['source_charged'])
        self.assertEqual(recovered['unknown_usage'], 1)

    def test_reconciliation_never_releases_money_or_reserved_tokens(self):
        row = self.reserve()
        row = self.store.transact(row['head_sha256'], 'intent', 'a1')
        result = self.store.transact(row['head_sha256'], 'reconcile', 'a1', 0, 0, 'e'*64)
        self.assertEqual(result['source_money']['charged'], 10)
        self.assertEqual(result['source_charged'], row['source_charged'])

    def test_actual_source_publish_fault_prefixes_keep_both_or_refuse(self):
        # Exercise real _publish at each operation boundary, not a side ledger.
        for target in ('write', 'fchmod', 'file_fsync', 'directory_fsync'):
            for after in (False, True):
                with self.subTest(target=target, after=after), tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp)/'store'; path.mkdir(mode=0o700)
                    with j.Journal(path) as store:
                        head = store.initialize(a.initial('1'*64, m.FLOOR, '2'*64))['head_sha256']
                        f=setup_fixture(head); store.monetary_verifier=f.args()['verify']; store.clock=lambda:20
                        expected=a.reserve_money(a.initial('1'*64,m.FLOOR,'2'*64), f.request,f.wire,
                                                 f.policy_raw,f.bounds_raw,verify=f.args()['verify'],now=20)
                        real_write=os.write; real_chmod=os.fchmod; real_sync=os.fsync
                        armed=[False]
                        def write(fd, data):
                            armed[0]=True
                            if target=='write' and not after: raise OSError('synthetic fault')
                            n=real_write(fd,data)
                            if target=='write' and after: raise OSError('synthetic fault')
                            return n
                        def chmod(fd, mode):
                            if target=='fchmod' and not after: raise OSError('synthetic fault')
                            real_chmod(fd,mode)
                            if target=='fchmod' and after: raise OSError('synthetic fault')
                        def sync(fd):
                            selected=armed[0] and ((target=='directory_fsync' and fd==store.root) or
                                                    (target=='file_fsync' and fd!=store.root))
                            if selected and not after: raise OSError('synthetic fault')
                            real_sync(fd)
                            if selected and after: raise OSError('synthetic fault')
                        with mock.patch.object(j.os,'write',side_effect=write), mock.patch.object(j.os,'fchmod',side_effect=chmod), mock.patch.object(j.os,'fsync',side_effect=sync):
                            with self.assertRaises(Refused):
                                store.transact(head,'reserve_money',f.request,f.wire,f.policy_raw,f.bounds_raw)
                        files=list(path.glob('event-*')); self.assertEqual(len(files),1)
                        # Partial/custody-invalid files refuse; complete files
                        # replay BOTH liabilities and stale pre-head refuses.
                        with self.assertRaises(Refused): store.read(head)
                        try: loaded=store.read(a.fold(expected)[1])
                        except Refused: continue
                        self.assertEqual(a.observe(loaded)['source_money']['charged'],10)
                        self.assertEqual(a.observe(loaded)['source_charged'],a.observe(expected)['source_charged'])

    def test_real_competing_journal_transactions_admit_at_most_one(self):
        ctx=multiprocessing.get_context('fork');ready=ctx.Queue();results=ctx.Queue();start=ctx.Event()
        jobs=[ctx.Process(target=contend,args=(str(self.path),self.head,ready,start,results,x)) for x in ('a','b')]
        for p in jobs:p.start()
        for _ in jobs:ready.get(timeout=5)
        start.set(); rows=[results.get(timeout=5) for _ in jobs]
        for p in jobs:p.join(5);self.assertEqual(p.exitcode,0)
        self.assertEqual(sum(r[0]=='accepted' for r in rows),1)
        self.assertEqual(len(list(self.path.glob('event-*'))),1)


if __name__ == '__main__': unittest.main()
