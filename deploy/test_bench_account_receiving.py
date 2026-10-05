"""Pure source contracts; fixtures never establish native financial authority."""
import asyncio
from dataclasses import replace
import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location('account_receiving', Path(__file__).with_name('bench-account-receiving.py'))
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)


class SourceContracts(unittest.TestCase):
    def setUp(self):
        self.scope = r.AccountScope('31a9c0b9-c50a-41f9-ab11-168299e40afe',
                                   'fixture-account', 'fixture-subject', 'a' * 40, 'b' * 64, 'c' * 64)
        self.receipts = {k: ('fixture-' + k).encode() for k in r.KINDS}
        self.now = 100

    def prepare(self, resolver=None, **changes):
        values = dict(scope=self.scope, receipts=self.receipts, resolver=resolver, clock=lambda: self.now)
        values.update(changes)
        return asyncio.run(r.prepare_account_verifier(**values))

    def resolver(self, mutation=lambda p: p):
        outer = self
        class FixtureResolver:
            async def resolve(self, kind, receipt, scope):
                return mutation(r.ResolvedAccountReceipt(kind, hashlib.sha256(receipt).hexdigest(),
                    scope, 'fixture-original-' + kind, 'fixture-principal-' + kind,
                    'fixture-current-revocation', False, outer.now + 20))
        return FixtureResolver()

    def test_default_and_missing_receipt_refuse(self):
        self.assertIsNone(self.prepare())
        self.assertIsNone(self.prepare(self.resolver(), receipts={}))

    def test_separate_roles_bound_bytes_and_expiry(self):
        verifier = self.prepare(self.resolver())
        self.assertIsNotNone(verifier)
        self.assertFalse(verifier.runtime_authorized)
        self.assertTrue(verifier.source_only)
        self.assertTrue(verifier('account-designation', self.receipts['account-designation']))
        self.assertFalse(verifier('charging-policy', self.receipts['account-designation']))
        self.assertFalse(verifier('account-designation', b'changed'))
        self.assertFalse(verifier('account-designation', 'string-input'))
        self.now += 21
        self.assertFalse(verifier('account-designation', self.receipts['account-designation']))

    def test_async_boolean_is_not_role_evidence(self):
        self.assertIsNone(self.prepare(self.resolver(lambda p: True)))

    def test_sync_boolean_cannot_be_awaited_as_native_evidence(self):
        class WrongInterface:
            def resolve(self, *args): return True
        self.assertIsNone(self.prepare(WrongInterface()))

    def test_scope_digest_role_revocation_and_issuer_refuse(self):
        mutations = [lambda p: replace(p, scope=replace(p.scope, account='other')),
                     lambda p: replace(p, receipt_sha256='d' * 64),
                     lambda p: replace(p, kind='charging-policy'),
                     lambda p: replace(p, revoked=True),
                     lambda p: replace(p, valid_until=100),
                     lambda p: replace(p, issuer_subject='same-principal'),
                     lambda p: replace(p, current_revocation_reference='')]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.assertIsNone(self.prepare(self.resolver(mutation)))

    def test_resolver_exception_does_not_expose_payload(self):
        class Broken:
            async def resolve(self, *args): raise RuntimeError('sentinel-never-log')
        self.assertIsNone(self.prepare(Broken()))

    def test_bad_composition_and_legacy_fifteen_are_not_adopted(self):
        self.assertFalse(r.qualify_composition(b'{}', b'{}', {}, b'changed'))

    def direct_proofs(self):
        return tuple(r.ResolvedAccountReceipt(kind, hashlib.sha256(self.receipts[kind]).hexdigest(),
            self.scope, 'fixture-original-' + kind, 'fixture-principal-' + kind,
            'fixture-current-revocation', False, 120) for kind in r.KINDS)

    def test_direct_empty_incomplete_duplicate_and_untyped_proofs_refuse(self):
        first, second = self.direct_proofs()
        cases = [(), (first,), (first, first), (first, second, second),
                 (True, second), (first, None), [first, second],
                 (first, replace(second, kind='charging-policy'))]
        for proofs in cases:
            with self.subTest(proofs=proofs):
                verifier = r.PreparedAccountVerifier(self.receipts, proofs, self.scope, lambda: self.now)
                for kind in r.KINDS:
                    self.assertFalse(verifier(kind, self.receipts[kind]))

    def test_direct_malformed_role_binding_and_authority_fields_refuse(self):
        first, second = self.direct_proofs()
        changes = [dict(scope=replace(self.scope, account='other')),
                   dict(receipt_sha256='d' * 64), dict(revoked=True),
                   dict(revoked=0), dict(valid_until=100), dict(valid_until=True),
                   dict(original_issuer_reference=first.original_issuer_reference),
                   dict(issuer_subject=first.issuer_subject),
                   dict(original_issuer_reference=''), dict(issuer_subject=None),
                   dict(current_revocation_reference='')]
        for change in changes:
            with self.subTest(change=change):
                verifier = r.PreparedAccountVerifier(self.receipts, (first, replace(second, **change)),
                                                       self.scope, lambda: self.now)
                self.assertFalse(verifier(r.KINDS[0], self.receipts[r.KINDS[0]]))

    def test_direct_bad_inputs_and_clock_fail_closed_without_logs(self):
        import contextlib
        import io
        def broken_clock(): raise RuntimeError('sentinel-never-log')
        cases = [({}, self.scope, lambda: 100), (None, self.scope, lambda: 100),
                 (self.receipts, replace(self.scope, task='bad'), lambda: 100),
                 (self.receipts, self.scope, lambda: float('nan')),
                 (self.receipts, self.scope, lambda: float('inf')),
                 (self.receipts, self.scope, lambda: True),
                 (self.receipts, self.scope, lambda: '100'),
                 (self.receipts, self.scope, broken_clock)]
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            for receipts, scope, clock in cases:
                with self.subTest(scope=scope, clock=clock):
                    verifier = r.PreparedAccountVerifier(receipts, self.direct_proofs(), scope, clock)
                    self.assertFalse(verifier(r.KINDS[0], self.receipts[r.KINDS[0]]))
        self.assertEqual(output.getvalue(), '')

    def test_direct_valid_independent_pair_and_call_revalidation(self):
        proofs = self.direct_proofs()
        verifier = r.PreparedAccountVerifier(self.receipts, tuple(reversed(proofs)), self.scope,
                                               lambda: self.now)
        for kind in r.KINDS:
            self.assertTrue(verifier(kind, self.receipts[kind]))
        self.assertFalse(verifier.runtime_authorized)
        self.assertTrue(verifier.source_only)
        self.receipts[r.KINDS[0]] = b'changed-external-dict'
        self.assertTrue(verifier(r.KINDS[0], b'fixture-account-designation'))
        for change in [dict(kind='charging-policy'), dict(receipt_sha256='d' * 64),
                       dict(current_revocation_reference=''), dict(revoked=True),
                       dict(original_issuer_reference=proofs[0].original_issuer_reference)]:
            verifier._proofs = (proofs[0], replace(proofs[1], **change))
            self.assertFalse(verifier(r.KINDS[0], b'fixture-account-designation'))
        verifier._proofs = proofs
        self.now = 120
        self.assertFalse(verifier(r.KINDS[0], b'fixture-account-designation'))


if __name__ == '__main__':
    unittest.main()
