"""Synthetic nonproduction arithmetic; zero model calls or native transport."""
from dataclasses import FrozenInstanceError, replace
import json
import random
import unittest

import accounting as a
from instrument import Refused


def request(output=10, **extra):
    return a.encoded(dict({'model': 'synthetic', 'input': [
        {'type': 'message', 'role': 'user', 'content': 'synthetic nonproduction'}],
        'max_output_tokens': output}, **extra))


def seed(baseline=(180, 0, 0)):
    return a.initial('1'*64, baseline, '2'*64)


def reserved(ledger=None, ident='attempt1', upper=20, output=10):
    return a.reserve(seed() if ledger is None else ledger, ident,
                     request(output), upper, output, '3'*64)


class AccountingSource(unittest.TestCase):
    def test_reservation_charged_before_forward_intent(self):
        before = seed(); after = reserved(before)
        self.assertEqual(a.observe(after)['source_charged'], (181, 20, 10))
        self.assertEqual(a.observe(before)['source_charged'], (180, 0, 0))
        self.assertEqual(a.fold(after)[0]['attempt1'].phase, 'RESERVED')

    def test_source_producer_never_grants_authority(self):
        ledger = reserved()
        row = a.observe(ledger)
        self.assertFalse(row['runtime_authorized'])
        self.assertFalse(row['accounting_admitted'])
        self.assertFalse(row['references_authenticated'])
        self.assertEqual(row['durability'], 'NOT_MEASURED')
        self.assertEqual(row['actual_upstream_accounting'], 'NOT_MEASURED')
        self.assertEqual(row['model_calls'], 0)
        self.assertEqual(a.restore(a.snapshot(ledger), row['head_sha256']), ledger)

    def test_exact_three_caps_allow_last_attempt_then_refuse(self):
        ledger = reserved(seed((527, 9_999_980, 1_499_990)))
        self.assertEqual(a.observe(ledger)['source_charged'], a.CAPS)
        with self.assertRaisesRegex(Refused, '^cap_exceeded$'):
            reserved(ledger, 'attempt2')
        self.assertEqual(a.observe(ledger)['source_remaining'], (0, 0, 0))

    def test_each_cap_refuses_independently(self):
        for baseline in [(528, 0, 0), (180, 9_999_981, 0), (180, 0, 1_499_991)]:
            ledger = seed(baseline)
            with self.assertRaisesRegex(Refused, '^cap_exceeded$'):
                reserved(ledger)
            self.assertEqual(len(ledger.events), 0)

    def test_baseline_cannot_reset_historical_calls(self):
        for calls in [0, 179]:
            with self.assertRaisesRegex(Refused, '^historical_consumption_not_preserved$'):
                seed((calls, 0, 0))

    def test_integer_quantities_refuse_bool_negative_float_and_zero_bound(self):
        for value in [True, -1, 1.5, None, 0]:
            with self.assertRaises(Refused):
                reserved(upper=value)
        for value in [True, -1, 1.5, None]:
            with self.assertRaises(Refused):
                seed((180, value, 0))

    def test_attempt_replay_is_data_recovery_without_second_debit(self):
        first = reserved(); again = reserved(first)
        self.assertIs(again, first)
        self.assertEqual(len(again.events), 1)
        self.assertEqual(a.observe(again)['source_charged'][0], 181)
        with self.assertRaises(FrozenInstanceError):
            again.baseline = (0, 0, 0)

    def test_conflicting_attempt_replay_refused(self):
        first = reserved()
        for body, upper, output, ref in [(request(10, model='other'), 20, 10, '3'*64),
                                       (request(), 21, 10, '3'*64),
                                       (request(11), 20, 11, '3'*64),
                                       (request(), 20, 10, '4'*64)]:
            with self.assertRaisesRegex(Refused, '^attempt_replay_conflict$'):
                a.reserve(first, 'attempt1', body, upper, output, ref)

    def test_usage_requires_preceding_intent(self):
        with self.assertRaisesRegex(Refused, '^reconcile_transition$'):
            a.reconcile(reserved(), 'attempt1', 5, 5, '4'*64)

    def test_intent_replay_does_not_authorize_send(self):
        first = a.intent(reserved(), 'attempt1')
        self.assertIs(a.intent(first, 'attempt1'), first)
        self.assertFalse(a.observe(first)['runtime_authorized'])
        self.assertEqual(a.observe(first)['source_charged'], (181, 20, 10))

    def test_known_usage_keeps_attempt_debit(self):
        ledger = a.reconcile(a.intent(reserved(), 'attempt1'), 'attempt1', 7, 3, '4'*64)
        self.assertEqual(a.observe(ledger)['source_charged'], (181, 7, 3))
        self.assertEqual(a.fold(ledger)[0]['attempt1'].phase, 'RECONCILED')

    def test_unknown_after_reservation_or_intent_holds_full_amount(self):
        for ledger in [reserved(), a.intent(reserved(), 'attempt1')]:
            held = a.unknown(ledger, 'attempt1')
            self.assertEqual(a.observe(held)['source_charged'], (181, 20, 10))
            self.assertEqual(a.observe(held)['unknown_usage'], 1)
            self.assertIs(a.unknown(held, 'attempt1'), held)

    def test_unknown_usage_fences_new_attempts(self):
        held = a.unknown(reserved(), 'attempt1')
        with self.assertRaisesRegex(Refused, '^unknown_usage_fence$'):
            reserved(held, 'attempt2')
        self.assertEqual(len(held.events), 2)

    def test_unknown_cannot_be_released_by_caller_receipt(self):
        held = a.unknown(a.intent(reserved(), 'attempt1'), 'attempt1')
        with self.assertRaisesRegex(Refused, '^reconcile_transition$'):
            a.reconcile(held, 'attempt1', 0, 0, '4'*64)
        self.assertEqual(a.observe(held)['source_charged'], (181, 20, 10))

    def test_unknown_fences_intent_for_already_reserved_attempt(self):
        ledger = reserved(reserved(), 'attempt2')
        held = a.unknown(ledger, 'attempt1')
        with self.assertRaisesRegex(Refused, '^unknown_usage_fence$'):
            a.intent(held, 'attempt2')
        with self.assertRaisesRegex(Refused, '^unknown_usage_fence$'):
            a.append(held, {'kind': 'intent', 'id': 'attempt2'})
        self.assertEqual(a.fold(held)[0]['attempt2'].phase, 'RESERVED')

    def test_terminal_usage_cannot_reenter_intent_or_unknown(self):
        closed = a.reconcile(a.intent(reserved(), 'attempt1'), 'attempt1', 7, 3, '4'*64)
        for op in [a.intent, a.unknown]:
            with self.assertRaises(Refused):
                op(closed, 'attempt1')

    def test_usage_replay_must_match_and_stay_typed(self):
        closed = a.reconcile(a.intent(reserved(), 'attempt1'), 'attempt1', 1, 3, '4'*64)
        self.assertIs(a.reconcile(closed, 'attempt1', 1, 3, '4'*64), closed)
        for inp, out, ref in [(True, 3, '4'*64), (1, 4, '4'*64), (1, 3, '5'*64)]:
            with self.assertRaises(Refused):
                a.reconcile(closed, 'attempt1', inp, out, ref)

    def test_reported_usage_breach_refuses_without_mutating_reserved_state(self):
        ledger = a.intent(reserved(), 'attempt1')
        for inp, out in [(21, 1), (1, 11), (-1, 1)]:
            with self.assertRaises(Refused):
                a.reconcile(ledger, 'attempt1', inp, out, '4'*64)
        self.assertEqual(a.observe(ledger)['source_charged'], (181, 20, 10))

    def test_snapshot_cannot_change_caps_or_self_assert_runtime(self):
        ledger = reserved(); head = a.observe(ledger)['head_sha256']
        doc = json.loads(a.snapshot(ledger)); doc['caps'][0] = 529
        with self.assertRaisesRegex(Refused, '^caps_not_immutable$'):
            a.restore(a.encoded(doc), head)
        doc = json.loads(a.snapshot(ledger)); doc['runtime_authorized'] = True
        with self.assertRaisesRegex(Refused, '^snapshot_shape$'):
            a.restore(a.encoded(doc), head)

    def test_tail_loss_detected_against_expected_head(self):
        ledger = a.intent(reserved(), 'attempt1'); head = a.observe(ledger)['head_sha256']
        doc = json.loads(a.snapshot(ledger)); doc['events'].pop()
        with self.assertRaisesRegex(Refused, '^snapshot_head_mismatch$'):
            a.restore(a.encoded(doc), head)

    def test_reordered_altered_or_duplicate_events_refused(self):
        ledger = a.intent(reserved(), 'attempt1'); head = a.observe(ledger)['head_sha256']
        original = json.loads(a.snapshot(ledger))
        for events in [list(reversed(original['events'])), original['events']*2]:
            changed = dict(original, events=events)
            with self.assertRaises(Refused):
                a.restore(a.encoded(changed), head)
        changed = json.loads(a.snapshot(ledger)); changed['events'][0]['data']['reservation'][1] = 1
        with self.assertRaises(Refused):
            a.restore(a.encoded(changed), head)

    def test_crash_prefix_recovery_never_refunds_or_repeats_debit(self):
        first = reserved(); second = a.intent(first, 'attempt1'); third = a.unknown(second, 'attempt1')
        for ledger in [first, second, third]:
            recovered = a.restore(a.snapshot(ledger), a.observe(ledger)['head_sha256'])
            self.assertEqual(a.observe(recovered)['source_charged'], (181, 20, 10))
            self.assertIs(reserved(recovered), recovered)
        self.assertEqual(second.events[:len(first.events)], first.events)
        self.assertEqual(third.events[:len(second.events)], second.events)

    def test_tools_and_extended_history_refused_before_reservation(self):
        bad = [request(tools=[{'type': 'function'}])]
        for kind in ['custom_tool_call', 'local_shell_call_output', 'future_tool_history']:
            doc = json.loads(request()); doc['input'].append({'type': kind}); bad.append(a.encoded(doc))
        for raw in bad:
            with self.assertRaises(Refused):
                a.reserve(seed(), 'attempt1', raw, 20, 10, '3'*64)

    def test_deterministic_generated_sequences_never_exceed_source_caps(self):
        randomizer = random.Random(196)
        ledger = seed((490, 9_999_000, 1_499_000))
        for number in range(38):
            upper = randomizer.randint(1, 20); output = randomizer.randint(1, 20)
            ident = f'attempt{number}'
            ledger = reserved(ledger, ident, upper, output)
            ledger = a.intent(ledger, ident)
            ledger = a.reconcile(ledger, ident, randomizer.randint(0, upper),
                                 randomizer.randint(0, output), '4'*64)
            self.assertTrue(all(n <= cap for n, cap in zip(a.observe(ledger)['source_charged'], a.CAPS)))
        self.assertEqual(a.observe(ledger)['source_charged'][0], 528)
        with self.assertRaises(Refused):
            reserved(ledger, 'one_more')

    def test_output_cap_missing_malformed_or_mismatched_refused(self):
        for output in [None, True, 0, 9, '10']:
            with self.assertRaises(Refused):
                a.reserve(seed(), 'attempt1', request(output), 20, 10, '3'*64)
        doc = json.loads(request()); del doc['max_output_tokens']
        with self.assertRaisesRegex(Refused, '^request_output_cap_missing_or_mismatched$'):
            a.reserve(seed(), 'attempt1', a.encoded(doc), 20, 10, '3'*64)

    def test_reference_shape_is_never_authentication(self):
        for ref in ['', 'credential', '1'*63, True]:
            with self.assertRaises(Refused):
                a.reserve(seed(), 'attempt1', request(), 20, 10, ref)
        self.assertFalse(a.observe(reserved())['references_authenticated'])

    def test_attempt_identifier_refused_without_arbitrary_exception(self):
        for ident in [None, [], '', 'space here', 'x'*129]:
            for op in [a.intent, a.unknown]:
                with self.assertRaises(Refused):
                    op(reserved(), ident)

    def test_348_unused_source_attempts_are_not_900_packet_cases(self):
        ledger = seed()
        for number in range(348):
            ledger = reserved(ledger, f'attempt{number}', upper=1, output=1)
        self.assertEqual(a.observe(ledger)['source_charged'][0], 528)
        with self.assertRaisesRegex(Refused, '^cap_exceeded$'):
            reserved(ledger, 'attempt349', upper=1, output=1)

    def test_unknown_event_and_invalid_envelope_refused(self):
        ledger = reserved()
        for kind in ['refund', 'reset', 'cancel', 'new_campaign']:
            with self.assertRaisesRegex(Refused, '^unknown_event_kind$'):
                a.append(ledger, {'kind': kind, 'id': 'attempt1'})
        event = json.loads(ledger.events[0]); event['seq'] = True
        with self.assertRaisesRegex(Refused, '^event_chain$'):
            a.fold(replace(ledger, events=(a.encoded(event),)))


if __name__ == '__main__':
    unittest.main()
