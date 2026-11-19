"""Offline actual Journal custodian controls; synthetic authority only."""
import copy
import tempfile
from pathlib import Path
import unittest
from unittest import mock

import accounting as a
import monetary as m
import journal as j
import custodian as c
from instrument import Refused
from test_monetary_journal import setup_fixture


class CustodianTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='custodian-')
        self.path = Path(self.temp.name)/'store'; self.path.mkdir(mode=0o700)
        self.store = j.Journal(self.path)
        self.head = self.store.initialize(a.initial('1'*64, m.FLOOR, '2'*64))['head_sha256']
        self.f = setup_fixture(self.head)
        for obj in (self.f.request, self.f.policy, self.f.bounds):
            obj.update(provider='chatgpt-subscription', model='gpt-6-luna')
        self.f.request['nonce'] = 'b'*64
        self.f.wire = a.encoded({'model': 'gpt-6-luna',
                                'input': [{'type': 'message', 'content': 'synthetic full wire'}]})
        for obj in (self.f.request, self.f.bounds): obj['wire_sha256'] = a.digest(self.f.wire)
        self.f.bounds.update(input_upper=len(self.f.wire), context_limit=1000,
                             output_enforcement='verified_native_hard_maximum')
        self.f.policy['money_cap'] = 100
        self.f.refresh()
        self.request = {k: v for k, v in self.f.request.items()
                        if k not in ('policy_sha256', 'bounds_sha256', 'original_ledger_sha256')}
        self.request.update(schema='NativeBenchReservationRequest/v2', subject='synthetic-subject',
                            accounting_schema='NativeBenchAccounting/v2', reserved_units=c.UNITS[:],
                            wire_utf8_bytes=len(self.f.wire), input_token_upper_bound=len(self.f.wire),
                            input_policy='TEXT_ONLY_UTF8_BYTES_UPPER_BOUND',
                            output_policy='AUTHENTICATED_MODEL_HARD_MAXIMUM_NO_RELEASE',
                            bounds_proof_sha256='e'*64, reserved=[1, len(self.f.wire), 2],
                            caps=list(a.CAPS), retained_baseline=list(m.FLOOR),
                            monetary_request=self.f.request.copy(),
                            monetary_checkpoint_head_sha256=self.head)
        self.now = 20
        self.store.clock = lambda: self.now
        self.store.monetary_verifier = self.f.args()['verify']
        self.binding = (a.encoded(self.request), self.f.wire, self.f.policy_raw,
                        self.f.bounds_raw, 24)
        self.admit = lambda value: value == self.binding

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def reserve(self, **kwargs):
        args = dict(deadline_unix=24, admit=self.admit); args.update(kwargs)
        return c.reserve_atomic(self.store, self.request, self.f.wire,
                                self.f.policy_raw, self.f.bounds_raw, **args)

    def test_actual_witness_reopens_unknown_and_both_liabilities(self):
        receipt = self.reserve()
        with j.Journal(self.path) as reopened:
            ledger = reopened.read(receipt['head_sha256'])
        observation = a.observe(ledger)
        self.assertEqual(observation['unknown_usage'], 1)
        self.assertEqual(observation['event_count'], 2)
        self.assertEqual(receipt['aggregate'], list(observation['source_charged']))
        self.assertEqual(receipt['monetary']['next_money'], observation['source_money']['charged'])
        self.assertEqual(receipt['monetary']['previous_money'], 7)
        self.assertEqual(receipt['sequence'], 181)
        self.assertEqual(receipt['previous_head_sha256'], self.head)
        self.assertFalse(observation['can_send'])
        expected_binding = a.digest(a.encoded(dict(request=self.f.request,
            previous=dict(head=self.head, counters=list(m.FLOOR), money=7,
                          currency='USD', scale=self.f.policy['scale'],
                          policy_sha256=a.digest(self.f.policy_raw)),
            reserved=self.request['reserved'], cost=receipt['monetary']['cost'])))
        self.assertEqual(receipt['monetary']['projection_binding_sha256'], expected_binding)

    def test_missing_authority_wrong_binding_and_signature_publish_nothing(self):
        for admission in (None, lambda _: False, lambda _: 1):
            with self.subTest(admission=admission), self.assertRaises(Refused):
                self.reserve(admit=admission)
        self.request['subject'] = 'other'
        with self.assertRaises(Refused): self.reserve()
        self.request['subject'] = 'synthetic-subject'
        self.store.monetary_verifier = lambda *_: False
        with self.assertRaises(m.Refused): self.reserve()
        self.assertEqual(self.store._load().events, ())

    def test_false_admission_causally_blocks_first_publication(self):
        with self.assertRaisesRegex(Refused, 'custodian_authority_refused'):
            self.reserve(admit=lambda _: False)
        self.assertEqual(self.store._load().events, ())

    def test_exact_shape_alias_caps_and_bound_controls(self):
        original = copy.deepcopy(self.request)
        mutations = [lambda r: r.update(extra=True), lambda r: r.update(account='other'),
                     lambda r: r['caps'].__setitem__(0, 529),
                     lambda r: r['reserved'].__setitem__(1, len(self.f.wire)-1),
                     lambda r: r.update(accounting_schema='NativeBenchAccounting/v1'),
                     lambda r: r['monetary_request'].update(extra=True)]
        for mutate in mutations:
            self.request = copy.deepcopy(original); mutate(self.request)
            # Bypass only fixture admission so the real structural check is causal.
            with self.subTest(mutate=mutate), self.assertRaises((Refused, m.Refused)):
                self.reserve(admit=lambda _: True)
            self.assertEqual(self.store._load().events, ())

    def test_deadline_before_write_and_late_after_write_never_refunds(self):
        self.now = 24
        with self.assertRaises(Refused): self.reserve()
        self.assertEqual(self.store._load().events, ())
        self.now = 20
        real = self.store._publish
        def late(name, raw):
            real(name, raw)
            if name == 'event-000002.json': self.now = 24
        with mock.patch.object(self.store, '_publish', side_effect=late):
            with self.assertRaisesRegex(Refused, 'custodian_expired'): self.reserve()
        observation = a.observe(self.store._load())
        self.assertEqual(observation['unknown_usage'], 1)
        self.assertGreater(observation['source_money']['charged'], 7)
        self.assertEqual(observation['source_charged'][0], 181)

    def test_crash_prefix_cannot_be_retried_with_fresh_head(self):
        real = self.store._publish
        def crash(name, raw):
            if name == 'event-000002.json': raise OSError('synthetic interruption')
            real(name, raw)
        with mock.patch.object(self.store, '_publish', side_effect=crash):
            with self.assertRaisesRegex(Refused, 'journal_io_failed'): self.reserve()
        partial = self.store._load()
        self.assertEqual(len(partial.events), 1)
        self.assertEqual(a.fold(partial)[0]['a1'].phase, 'RESERVED')
        self.request['monetary_checkpoint_head_sha256'] = a.fold(partial)[1]
        for row in (self.request, self.request['monetary_request']):
            row.update(attempt='a2', nonce='c'*64)
        with self.assertRaisesRegex(Refused, 'custodian_unresolved_fence'):
            self.reserve(admit=lambda _: True)
        self.assertEqual(self.store._load().events, partial.events)

    def test_replay_and_competing_existing_journal_handle_refuse(self):
        with j.Journal(self.path) as competing:
            with competing._locked():
                with self.assertRaisesRegex(Refused, 'journal_busy'): self.reserve()
        receipt = self.reserve()
        with self.assertRaisesRegex(Refused, 'journal_stale_head'): self.reserve()
        self.request['monetary_checkpoint_head_sha256'] = receipt['head_sha256']
        with self.assertRaisesRegex(Refused, 'custodian_unresolved_fence'):
            self.reserve(admit=lambda _: True)
        self.assertEqual(len(self.store._load().events), 2)

    def test_revocation_after_reservation_returns_no_witness_keeps_unknown(self):
        calls = []
        def revoke(value):
            calls.append(value)
            return len(calls) < 3
        with self.assertRaisesRegex(Refused, 'custodian_authority_refused'):
            self.reserve(admit=revoke)
        self.assertEqual(a.observe(self.store._load())['unknown_usage'], 1)


if __name__ == '__main__': unittest.main()
