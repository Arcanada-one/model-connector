"""Disconnected account-receipt preparation; no loader, Journal or send authority.

The original incumbent must implement the independent role-aware byte resolver.
MC charging-policy/wire-bounds string verification is a different interface.
Even qualified source inputs do not admit an installed binary or financial effect.
"""
from dataclasses import dataclass
import hashlib
import json
import re
import time
from typing import Literal, Protocol

Kind = Literal['account-designation', 'account-checkpoint']
KINDS = ('account-designation', 'account-checkpoint')
COMPOSITION_SHA256 = 'cea6886322d5d821e1e5aa2d650949ef6fbd2176168a43b47fabcf473113b897'
ADAPTER_SHA256 = 'ed4341f5bf732dc504b52cb8323c9f45e8d4778e57ce222690e9d632137a4a48'
ORIGINAL_PINS_SHA256 = '3fa89a10c8f98d86b872912befd3b945fb9d8a11dfc220e42348fe09fe9ff486'


@dataclass(frozen=True)
class AccountScope:
    task: str
    account: str
    subject: str
    source_head: str
    binary_sha256: str
    checkpoint_head: str


@dataclass(frozen=True)
class ResolvedAccountReceipt:
    kind: Kind
    receipt_sha256: str
    scope: AccountScope
    original_issuer_reference: str
    issuer_subject: str
    current_revocation_reference: str
    revoked: bool
    valid_until: int


class OriginalAccountResolver(Protocol):
    """Resolve original issuer role/signature and current revocation internally.

    References/boolean results are insufficient; no key may be selected by the
    untrusted receipt. Tests inject fixtures, never an authenticated native route.
    """
    async def resolve(self, kind: Kind, receipt: bytes,
                      scope: AccountScope) -> ResolvedAccountReceipt | None: ...


def qualify_composition(original_pins: bytes, composition: bytes,
                        modules: dict[str, bytes], adapter: bytes) -> bool:
    """Validate supplied source bytes only; never import or execute a locator."""
    try:
        if (type(original_pins) is not bytes or type(composition) is not bytes
                or type(adapter) is not bytes or type(modules) is not dict):
            return False
        digest = lambda body: hashlib.sha256(body).hexdigest()
        if (digest(original_pins) != ORIGINAL_PINS_SHA256
                or digest(composition) != COMPOSITION_SHA256
                or digest(adapter) != ADAPTER_SHA256):
            return False
        old, pins = json.loads(original_pins), json.loads(composition)['modules']
        return (len(old) == 15 and len(pins) == 16
                and {k: v for k, v in pins.items() if k != 'receipts.py'} == old
                and set(modules) == set(pins)
                and all(type(modules[k]) is bytes and digest(modules[k]) == v
                        for k, v in pins.items()))
    except (ValueError, TypeError, KeyError):
        return False


class PreparedAccountVerifier:
    """Synchronous Billing byte interface, bound to one prepared observation.

    The incumbent must re-resolve both original roles at the actual transaction
    boundary. This source object supplies no execution lease or admission.
    """
    runtime_authorized = False
    source_only = True
    def __init__(self, receipts: dict[str, bytes], proofs: tuple,
                 scope: AccountScope, clock):
        self._digests = {k: hashlib.sha256(v).hexdigest() for k, v in receipts.items()}
        self._proofs, self._scope, self._clock = proofs, scope, clock

    def __call__(self, kind: Kind, receipt: bytes) -> bool:
        if kind not in KINDS or type(receipt) is not bytes:
            return False
        now = self._clock()
        return (all(p.scope == self._scope and p.revoked is False
                    and p.valid_until > now for p in self._proofs)
                and hashlib.sha256(receipt).hexdigest() == self._digests[kind])


async def prepare_account_verifier(scope: AccountScope, receipts: dict[str, bytes],
                                   resolver: OriginalAccountResolver | None = None,
                                   clock=time.time) -> PreparedAccountVerifier | None:
    """Default refuse; await role-specific evidence, never Promise truthiness."""
    if (type(scope) is not AccountScope or resolver is None
            or type(receipts) is not dict or set(receipts) != set(KINDS)
            or any(type(v) is not bytes or not 0 < len(v) <= 65536
                   for v in receipts.values())):
        return None
    if (not all(type(v) is str for v in (scope.task, scope.source_head,
                scope.binary_sha256, scope.checkpoint_head))
            or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', scope.task)
            or not all(type(v) is str and 0 < len(v) <= 256
                       for v in (scope.account, scope.subject))
            or not re.fullmatch(r'[a-f0-9]{40}', scope.source_head)
            or not all(re.fullmatch(r'[a-f0-9]{64}', v)
                       for v in (scope.binary_sha256, scope.checkpoint_head))):
        return None
    proofs = []
    try:
        for kind in KINDS:
            proof = await resolver.resolve(kind, receipts[kind], scope)
            if (type(proof) is not ResolvedAccountReceipt or proof.kind != kind
                    or proof.scope != scope or proof.revoked is not False
                    or type(proof.valid_until) is not int or proof.valid_until <= clock()
                    or not all(type(v) is str and 0 < len(v) <= 1024
                               for v in (proof.original_issuer_reference,
                                         proof.issuer_subject, proof.current_revocation_reference))
                    or proof.receipt_sha256 != hashlib.sha256(receipts[kind]).hexdigest()):
                return None
            proofs.append(proof)
        if (proofs[0].original_issuer_reference == proofs[1].original_issuer_reference
                or proofs[0].issuer_subject == proofs[1].issuer_subject):
            return None  # independent original checkpoint issuer, not designation reuse
        return PreparedAccountVerifier(dict(receipts), tuple(proofs), scope, clock)
    except Exception:
        return None  # never emit resolver exception or receipt bodies
