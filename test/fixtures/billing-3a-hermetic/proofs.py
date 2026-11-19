"""Detached Ed25519 proof verification with an externally pinned issuer key.

No issuer discovery, private keys, key creation or default trust. The caller
must obtain the public-key pin and detached signatures from the incumbent
authenticated custody boundary, never from the untrusted reservation request.
OpenSSL is a required local dependency; absence or any error refuses proof.
"""
from pathlib import Path
import subprocess
import tempfile

from instrument import require
from monetary import digest, hash_value


DOMAIN = b'BENCH-MONETARY-PROOF-v1\n'
ED25519_SPKI = bytes.fromhex('302a300506032b6570032100')
KINDS = frozenset(('charging-policy', 'wire-bounds'))


class PinnedProofVerifier:
    def __init__(self, public_der, expected_sha256, signatures, *, openssl='/usr/bin/openssl'):
        hash_value(expected_sha256)
        require(type(public_der) is bytes and len(public_der) == 44 and
                public_der.startswith(ED25519_SPKI) and
                digest(public_der) == expected_sha256, 'proof_issuer_pin')
        require(type(signatures) is dict and set(signatures) == KINDS and
                all(type(sig) is bytes and len(sig) == 64 for sig in signatures.values()),
                'proof_signature_shape')
        require(type(openssl) is str and Path(openssl).is_absolute(), 'proof_verifier_path')
        self.public_der = public_der
        self.signatures = signatures.copy()
        self.openssl = openssl

    def __call__(self, kind, raw):
        if kind not in KINDS or type(raw) is not bytes or not 0 < len(raw) <= 65536:
            return False
        try:
            with tempfile.TemporaryDirectory(prefix='bench-proof-') as name:
                root = Path(name)
                for filename, value in (('issuer.der', self.public_der),
                                        ('signature.bin', self.signatures[kind]),
                                        ('proof.bin', DOMAIN + kind.encode('ascii') + b'\n' + raw)):
                    path = root/filename
                    with path.open('xb') as stream: stream.write(value)
                    path.chmod(0o600)
                result = subprocess.run(
                    [self.openssl, 'pkeyutl', '-verify', '-rawin', '-pubin',
                     '-keyform', 'DER', '-inkey', str(root/'issuer.der'),
                     '-in', str(root/'proof.bin'), '-sigfile', str(root/'signature.bin')],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, timeout=2, check=False,
                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
                return result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False
