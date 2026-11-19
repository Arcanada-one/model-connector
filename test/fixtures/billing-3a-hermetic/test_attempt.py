"""Real owned source journal; synthetic authority and executor, no network."""
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import accounting as a
import attempt
import journal
import monetary as m
from instrument import Refused
from test_monetary_journal import setup_fixture


class OneAttempt(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='one-attempt-')
        self.path = Path(self.temp.name) / 'store'
        self.path.mkdir(mode=0o700)
        self.store = journal.Journal(self.path)
        self.head = self.store.initialize(a.initial('1'*64, m.FLOOR, '2'*64))['head_sha256']
        self.f = setup_fixture(self.head)
        self.store.monetary_verifier = self.f.args()['verify']
        self.store.clock = lambda: 20
        self.calls = 0

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def execute(self, wire):
        self.calls += 1
        rows, _ = a.fold(self.store._load())
        self.assertEqual(rows['a1'].phase, 'FORWARD_INTENT')
        self.assertIsNotNone(rows['a1'].monetary)
        return a.encoded({'attempt': 'a1', 'wire_sha256': a.digest(wire),
                          'input_tokens': 0, 'output_tokens': 0, 'receipt': 'e'*64})

    def run_once(self, **overrides):
        args = dict(admit_attempt=lambda binding: True, execute=self.execute,
                    verify_usage=lambda binding, raw: True)
        args.update(overrides)
        return attempt.run_once(self.store, self.head, self.f.request, self.f.wire,
                                self.f.policy_raw, self.f.bounds_raw, **args)

    def test_one_call_settles_without_releasing_money_or_tokens(self):
        row = self.run_once()
        self.assertEqual(self.calls, 1)
        self.assertEqual(row['source_money']['charged'], 10)
        self.assertEqual(row['source_charged'], (181, m.FLOOR[1]+4, m.FLOOR[2]+2))
        self.assertFalse(row['can_send'])
        self.assertFalse(row['runtime_authorized'])
        self.assertEqual(row['event_count'], 3)
        self.head = row['head_sha256']
        with self.assertRaises(m.Refused): self.run_once()
        self.assertEqual(self.calls, 1)

    def test_missing_and_denied_authority_never_reserve_or_call(self):
        for change in ({'admit_attempt': None}, {'admit_attempt': lambda b: False},
                       {'execute': None}, {'verify_usage': None}):
            with self.subTest(change=tuple(change)):
                with self.assertRaises(Refused): self.run_once(**change)
        self.assertEqual(self.calls, 0)
        self.assertEqual(self.store._load().events, ())

    def test_expiry_recheck_after_intent_consumes_without_call(self):
        answers = iter((True, False))
        with self.assertRaisesRegex(Refused, 'attempt_unknown_consumed'):
            self.run_once(admit_attempt=lambda b: next(answers))
        self.assertEqual(self.calls, 0)
        self.assertEqual(a.observe(self.store._load())['unknown_usage'], 1)

    def test_callback_failure_never_retries_and_fences_next_attempt(self):
        def fail(wire):
            self.calls += 1
            raise TimeoutError('synthetic ambiguous outcome')
        with self.assertRaisesRegex(Refused, 'attempt_unknown_consumed'):
            self.run_once(execute=fail)
        row = a.observe(self.store._load())
        self.assertEqual(row['unknown_usage'], 1)
        self.assertEqual(row['source_money']['charged'], 10)
        self.head = row['head_sha256']
        self.f.request['attempt'] = 'next'; self.f.request['nonce'] = 'next'
        with self.assertRaisesRegex(Refused, 'attempt_unresolved_fence'): self.run_once()
        self.assertEqual(self.calls, 1)

    def test_unauthenticated_or_substituted_usage_is_unknown(self):
        with self.assertRaisesRegex(Refused, 'attempt_unknown_consumed'):
            self.run_once(verify_usage=lambda b, raw: False)
        self.assertEqual(self.calls, 1)
        self.assertEqual(a.observe(self.store._load())['unknown_usage'], 1)

    def test_wrong_wire_in_usage_is_unknown(self):
        def substitute(wire):
            raw = a.strict_json(self.execute(wire)); raw['wire_sha256'] = 'f'*64
            return a.encoded(raw)
        with self.assertRaisesRegex(Refused, 'attempt_unknown_consumed'):
            self.run_once(execute=substitute)
        self.assertEqual(a.observe(self.store._load())['unknown_usage'], 1)

    def test_competing_reentrant_attempt_cannot_double_reserve(self):
        def compete(wire):
            with journal.Journal(self.path) as other:
                with self.assertRaisesRegex(Refused, 'journal_busy'):
                    other.transact(self.head, 'unknown', 'a1')
            return self.execute(wire)
        self.run_once(execute=compete)
        self.assertEqual(self.calls, 1)

    def test_money_and_token_exhaustion_precede_callback(self):
        self.f.policy['money_cap'] = 9; self.f.refresh()
        with self.assertRaisesRegex(m.Refused, 'money_cap'): self.run_once()
        self.f.policy['money_cap'] = 10
        self.f.bounds['input_upper'] = m.CAPS[1]
        self.f.bounds['context_limit'] = m.CAPS[1]+2; self.f.refresh()
        with self.assertRaises(m.Refused): self.run_once()
        self.assertEqual(self.calls, 0)
        self.assertEqual(self.store._load().events, ())

    def test_native_wire_without_authenticated_hard_maximum_refuses(self):
        raw = a.strict_json(self.f.wire); del raw['max_output_tokens']
        self.f.wire = a.encoded(raw)
        for row in (self.f.request, self.f.bounds): row['wire_sha256'] = a.digest(self.f.wire)
        self.f.refresh()
        with self.assertRaisesRegex(Refused, 'request_output_cap_missing_or_mismatched'):
            self.run_once()
        self.assertEqual(self.calls, 0)
        self.assertEqual(self.store._load().events, ())

    def test_authenticated_hard_maximum_without_wire_limiter_runs_once(self):
        raw = a.strict_json(self.f.wire); del raw['max_output_tokens']
        self.f.wire = a.encoded(raw)
        for row in (self.f.request, self.f.bounds): row['wire_sha256'] = a.digest(self.f.wire)
        self.f.bounds['output_enforcement'] = 'verified_native_hard_maximum'
        self.f.refresh()
        row = self.run_once()
        self.assertEqual(self.calls, 1)
        self.assertEqual(row['source_money']['charged'], 10)
        self.assertEqual(row['source_charged'], (181, m.FLOOR[1]+4, m.FLOOR[2]+2))
        self.assertNotIn('max_output_tokens', a.strict_json(self.f.wire))
        self.assertFalse(row['can_send'])

    def test_crash_after_reserve_recovery_keeps_full_liability(self):
        original = self.store._publish
        def crash(name, raw):
            original(name, raw)
            raise OSError('synthetic crash after durable reserve')
        with mock.patch.object(self.store, '_publish', side_effect=crash):
            with self.assertRaises(Refused): self.run_once()
        ledger = self.store._load(); self.head = a.fold(ledger)[1]
        with self.assertRaisesRegex(Refused, 'attempt_unresolved_fence'): self.run_once()
        row = self.store.recover(self.head)
        self.assertEqual(self.calls, 0)
        self.assertEqual(row['unknown_usage'], 1)
        self.assertEqual(row['source_money']['charged'], 10)

    def test_crash_at_intent_or_settle_does_not_repeat_callback(self):
        original = self.store._publish
        def crash(name, raw):
            original(name, raw)
            if name == 'event-000002.json': raise OSError('synthetic intent crash')
        with mock.patch.object(self.store, '_publish', side_effect=crash):
            with self.assertRaises(Refused): self.run_once()
        self.assertEqual(self.calls, 0)
        self.head = a.fold(self.store._load())[1]
        with self.assertRaisesRegex(Refused, 'attempt_unresolved_fence'): self.run_once()

    def test_ambiguous_settle_publication_keeps_reserve_and_never_reexecutes(self):
        original = self.store._publish
        def crash(name, raw):
            original(name, raw)
            if name == 'event-000003.json': raise OSError('synthetic settle crash')
        with mock.patch.object(self.store, '_publish', side_effect=crash):
            with self.assertRaises(Refused): self.run_once()
        row = a.observe(self.store._load()); self.head = row['head_sha256']
        self.assertEqual(row['source_money']['charged'], 10)
        with self.assertRaises(m.Refused): self.run_once()
        self.assertEqual(self.calls, 1)
