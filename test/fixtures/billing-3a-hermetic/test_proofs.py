"""Ephemeral synthetic Ed25519 keys, real crypto and Journal; no live authority."""
from pathlib import Path
import subprocess
import tempfile
import unittest

import accounting as a
import monetary as m
import proofs as p
import test_custodian as fixtures
from instrument import Refused


class ProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-proof-key-')
        self.root = Path(self.temp.name)
        self.fixture = fixtures.CustodianTests(); self.fixture.setUp()
        self.run_crypto('genpkey', '-algorithm', 'ED25519', '-out', str(self.root/'key.pem'))
        (self.root/'key.pem').chmod(0o600)
        self.run_crypto('pkey', '-in', str(self.root/'key.pem'), '-pubout',
                        '-outform', 'DER', '-out', str(self.root/'public.der'))
        self.public = (self.root/'public.der').read_bytes()
        self.raws = {'charging-policy': self.fixture.f.policy_raw,
                     'wire-bounds': self.fixture.f.bounds_raw}
        self.signatures = {kind: self.sign(p.DOMAIN + kind.encode() + b'\n' + raw)
                           for kind, raw in self.raws.items()}

    def tearDown(self): self.fixture.tearDown(); self.temp.cleanup()

    def run_crypto(self, *argv):
        subprocess.run(['/usr/bin/openssl', *argv], check=True, timeout=5,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)

    def sign(self, raw):
        (self.root/'message').write_bytes(raw)
        self.run_crypto('pkeyutl', '-sign', '-rawin', '-inkey', str(self.root/'key.pem'),
                        '-in', str(self.root/'message'), '-out', str(self.root/'signature'))
        return (self.root/'signature').read_bytes()

    def verifier(self, **kwargs):
        return p.PinnedProofVerifier(self.public, a.digest(self.public), self.signatures, **kwargs)

    def test_real_signatures_drive_actual_journal_witness(self):
        self.fixture.store.monetary_verifier = self.verifier()
        receipt = self.fixture.reserve()
        self.assertEqual(a.observe(self.fixture.store._load())['unknown_usage'], 1)
        self.assertGreater(receipt['monetary']['next_money'], 7)

    def test_changed_bytes_signature_kind_and_domain_refuse(self):
        good = self.verifier()
        for kind, raw in self.raws.items():
            self.assertTrue(good(kind, raw))
            self.assertFalse(good(kind, raw+b' '))
        self.signatures['wire-bounds'] = self.signatures['charging-policy']
        self.assertFalse(self.verifier()('wire-bounds', self.raws['wire-bounds']))
        self.signatures['wire-bounds'] = self.sign(self.raws['wire-bounds'])
        self.assertFalse(self.verifier()('wire-bounds', self.raws['wire-bounds']))
        self.fixture.store.monetary_verifier = self.verifier()
        with self.assertRaises(m.Refused): self.fixture.reserve()
        self.assertEqual(self.fixture.store._load().events, ())

    def test_wrong_issuer_pin_missing_dependency_and_signature_shape_refuse(self):
        with self.assertRaisesRegex(Refused, 'proof_issuer_pin'):
            p.PinnedProofVerifier(self.public, '0'*64, self.signatures)
        broken = self.verifier(openssl='/nonexistent/openssl')
        self.assertFalse(broken('wire-bounds', self.raws['wire-bounds']))
        self.signatures['wire-bounds'] = b'wrong'
        with self.assertRaisesRegex(Refused, 'proof_signature_shape'): self.verifier()

    def test_mutating_supplied_signatures_does_not_change_pinned_verifier(self):
        verifier = self.verifier()
        self.signatures['wire-bounds'] = bytes(64)
        self.assertTrue(verifier('wire-bounds', self.raws['wire-bounds']))


if __name__ == '__main__': unittest.main()
