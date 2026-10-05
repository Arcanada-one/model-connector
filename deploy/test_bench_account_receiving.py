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


if __name__ == '__main__':
    unittest.main()
