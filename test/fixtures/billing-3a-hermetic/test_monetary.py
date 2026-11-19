"""Synthetic offline tests, not authentic prices/authority or installed proof."""
import copy
import json
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from monetary import CAPS, FLOOR, MAX, ORIGINAL_LEDGER, Refused, prepare, charge, encoded, digest


class Fixture:
    def __init__(self):
        self.wire = encoded({'model': 'synthetic-model', 'input': 'complete wire',
                             'instructions': 'whole context', 'schema': {'type': 'object'}})
        scope = dict(campaign='synthetic', account='synthetic-account',
                     provider='synthetic-route', model='synthetic-model', source_sha256='d'*64,
                     binary_sha256='e'*64, journal_id='synthetic-journal', original_ledger_sha256=ORIGINAL_LEDGER)
        self.policy = dict(kind='charging-policy', not_before=10, expires=30, **scope,
                           currency='USD', scale=1000000, mode='metered', money_cap=100,
                           money_floor=7, retained_counters=list(FLOOR), baseline_head='a'*64, input_rate=[1, 3],
                           output_rate=[1, 3], fixed_fee=0, no_overage=True, no_fallback=True)
        self.bounds = dict(kind='wire-bounds', not_before=10, expires=30, **scope,
                           wire_sha256=digest(self.wire), input_upper=4, output_upper=2,
                           context_limit=8, output_enforcement='verified_native_limiter',
                           all_billable_units=True)
        self.request = dict(**scope, attempt='a1', nonce='n1', wire_sha256=digest(self.wire),
                            policy_sha256='', bounds_sha256='')
        self.current = dict(head='a'*64, counters=list(FLOOR), money=7,
                            currency='USD', scale=1000000, policy_sha256='')
        self.trusted = {}
        self.refresh()

    def refresh(self):
        # Exact fixture bytes are allowlisted; this is not a real issuer.
        self.policy_raw, self.bounds_raw = encoded(self.policy), encoded(self.bounds)
        self.request['policy_sha256'] = digest(self.policy_raw)
        self.request['bounds_sha256'] = digest(self.bounds_raw)
        self.current['policy_sha256'] = digest(self.policy_raw)
        self.trusted = {'charging-policy': self.policy_raw, 'wire-bounds': self.bounds_raw}

    def args(self):
        return dict(request=self.request, wire=self.wire, policy_receipt=self.policy_raw,
                    bounds_receipt=self.bounds_raw,
                    verify=lambda kind, raw: self.trusted.get(kind) == raw, now=20,
                    current=self.current, expected_head=self.current['head'])

    def run(self, **overrides):
        args = self.args(); args.update(overrides)
        return prepare(**args)


class MonetaryTests(unittest.TestCase):
    def test_missing_unverified_expired_and_wrong_scope(self):
        for kwargs in ({'policy_receipt': None}, {'bounds_receipt': None}, {'verify': None},
                       {'verify': lambda *_: False}, {'now': 30}, {'now': 9}):
            with self.subTest(kwargs=kwargs), self.assertRaises(Refused):
                Fixture().run(**kwargs)
        for key in ('account', 'provider', 'model', 'campaign', 'source_sha256', 'binary_sha256', 'journal_id', 'original_ledger_sha256'):
            f = Fixture(); f.policy[key] = 'other'; f.refresh()
            with self.subTest(key=key), self.assertRaises(Refused): f.run()
        f = Fixture(); f.current['currency'] = 'EUR'
        with self.assertRaises(Refused): f.run()

    def test_full_wire_mutation_and_missing_wrapper(self):
        f = Fixture()
        for raw in (f.wire+b' ', encoded({'input': 'complete wire'})):
            with self.subTest(raw=raw), self.assertRaises(Refused): f.run(wire=raw)
        f.request['bounds_sha256'] = 'b'*64
        with self.assertRaises(Refused): f.run()

    def test_integer_rounding_and_invalid_rates(self):
        f = Fixture()
        self.assertEqual(charge(f.policy, 4, 0), 2)
        self.assertEqual(charge(f.policy, 4, 2), 3)  # per-category ceilings
        for rate in ([1, 0], [True, 1], [-1, 3], [0.2, 1], [MAX+1, 1]):
            p = dict(f.policy, input_rate=rate)
            with self.subTest(rate=rate), self.assertRaises(Refused): charge(p, 4, 2)
        with self.assertRaises(Refused): charge(dict(f.policy, input_rate=[MAX, 1]), MAX, 2)
        with self.assertRaises(Refused): charge(dict(f.policy, input_rate=[0, 1], output_rate=[0, 1]), 4, 2)

    def test_subscription_never_defaults_to_zero(self):
        f = Fixture(); f.policy.update(mode='subscription_no_incremental_charge',
                                      input_rate=[0, 1], output_rate=[0, 1]); f.refresh()
        self.assertEqual(f.run().cost, 0)
        self.assertFalse(f.run().can_send)
        with self.assertRaises(Refused): f.run(policy_receipt=None)
        for key in ('no_overage', 'no_fallback'):
            g = Fixture(); g.policy[key] = False; g.refresh()
            with self.assertRaises(Refused): g.run()

    def test_exact_money_and_token_boundaries_and_floors(self):
        f = Fixture(); f.policy['money_cap'] = 10; f.refresh()
        self.assertEqual(f.run().next_money, 10)
        f.current['money'] = 8
        with self.assertRaises(Refused): f.run()
        f = Fixture(); f.current['counters'] = [CAPS[0]-1, CAPS[1]-4, CAPS[2]-2]
        self.assertEqual(f.run().next_counters, CAPS)
        for i in range(3):
            g = Fixture(); g.current['counters'][i] = FLOOR[i]-1
            with self.assertRaises(Refused): g.run()
        f.current['counters'][1] += 1
        with self.assertRaises(Refused): f.run()
        g = Fixture(); g.current['money'] = 6
        with self.assertRaises(Refused): g.run()

    def test_missing_stripped_output_or_billable_bounds(self):
        for key, value in [('output_enforcement', 'declared_only'), ('output_upper', 0),
                           ('all_billable_units', False), ('context_limit', 5)]:
            f = Fixture(); f.bounds[key] = value; f.refresh()
            with self.subTest(key=key), self.assertRaises(Refused): f.run()
        f = Fixture(); del f.bounds['output_upper']; f.refresh()
        with self.assertRaises(Refused): f.run()

    def test_strict_projection_compatibility_no_field_dropping(self):
        for key, value in [('schema', 'NativeBenchReservationRequest/v1'), ('reserved', [1, 4, 2]),
                           ('can_send', True), ('refund', 1)]:
            f = Fixture(); f.request[key] = value
            with self.subTest(key=key), self.assertRaises(Refused): f.run()
        f = Fixture(); del f.request['policy_sha256']
        with self.assertRaises(Refused): f.run()
        # Does not claim existing native v2 integration; this strict seam fails closed.

    def test_replay_head_mismatch_and_no_refund_projection(self):
        f = Fixture()
        for kwargs in ({'seen_attempts': ('a1',)}, {'seen_nonces': ('n1',)},
                       {'expected_head': 'c'*64}):
            with self.assertRaises(Refused): f.run(**kwargs)
        projection = f.run()
        self.assertGreaterEqual(projection.next_money, f.current['money'])
        self.assertEqual(projection.next_counters, tuple(n+r for n,r in zip(FLOOR,(1,4,2))))
        self.assertFalse(projection.can_send)

    def test_eight_crash_boundaries_and_real_sqlite_cas_competition(self):
        # Isolated transaction harness ONLY, not a replacement production ledger.
        with tempfile.TemporaryDirectory() as tmp:
            db = str(Path(tmp)/'fixture.db')
            with sqlite3.connect(db) as c:
                c.execute('CREATE TABLE checkpoint (id INTEGER PRIMARY KEY, head TEXT, money INTEGER)')
                c.execute('INSERT INTO checkpoint VALUES (1,?,7)', ('a'*64,))
            barrier = threading.Barrier(2)
            def reserve(name):
                f = Fixture(); f.policy['money_cap'] = 10; f.request['attempt'] = name
                f.request['nonce'] = name; f.refresh(); p = f.run(); barrier.wait()
                with sqlite3.connect(db, timeout=5) as c:
                    changed = c.execute('UPDATE checkpoint SET head=?,money=? WHERE id=1 AND head=? AND money=7',
                                        (p.binding, p.next_money, p.previous_head)).rowcount
                    return changed
            with ThreadPoolExecutor(max_workers=2) as pool:
                a=pool.submit(reserve, 'a'); b=pool.submit(reserve, 'b')
                self.assertEqual(a.result()+b.result(), 1)
            with sqlite3.connect(db) as c: self.assertEqual(c.execute('SELECT money FROM checkpoint').fetchone()[0], 10)
        # Independent durable checkpoint semantics: after commit, local failures
        # never issue a reversing UPDATE. Eight fault prefixes are exercised.
        for fault in range(8):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                db = str(Path(tmp)/'fixture.db')
                with sqlite3.connect(db) as c:
                    c.execute('CREATE TABLE checkpoint (money INTEGER)'); c.execute('INSERT INTO checkpoint VALUES (7)')
                try:
                    for step in range(8):
                        if step == fault: raise RuntimeError('synthetic crash')
                        if step == 2:
                            with sqlite3.connect(db) as c: c.execute('UPDATE checkpoint SET money=10')
                except RuntimeError: pass
                with sqlite3.connect(db) as c:
                    self.assertEqual(c.execute('SELECT money FROM checkpoint').fetchone()[0], 10 if fault>2 else 7)


if __name__ == '__main__': unittest.main()
