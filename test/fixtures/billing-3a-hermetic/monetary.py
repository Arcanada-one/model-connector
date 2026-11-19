"""Offline monetary projection; never a provider, issuer or send permit.

The incumbent receiver must authenticate every receipt via its existing trust
boundary and commit this projection in its existing atomic checkpoint. This
module does not implement a competing receiver, ledger or transport protocol.
"""
from dataclasses import dataclass
import hashlib
import json
import re

CAPS = (528, 10_000_000, 1_500_000)
FLOOR = (180, 1_695_917, 199_911)
MAX = 2**63 - 1
ORIGINAL_LEDGER = "416715bbf4b6f25a3ef9bb0c3085651792f66548789239e2e96c093e7e7e26fb"


class Refused(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise Refused(reason)


def integer(value, *, positive=False):
    require(type(value) is int and int(positive) <= value <= MAX, 'integer_range')
    return value


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def shape(value, keys):
    require(type(value) is dict and set(value) == set(keys.split()), 'strict_shape')


def hash_value(value):
    require(type(value) is str and re.fullmatch('[a-f0-9]{64}', value), 'digest_shape')


def counters(value):
    require(type(value) in (list, tuple) and len(value) == 3, 'counter_shape')
    for i, item in enumerate(value):
        integer(item)
        require(FLOOR[i] <= item <= CAPS[i], 'historical_floor_or_cap')
    return tuple(value)


def authenticated(receipt, kind, verify, now):
    # Canonical immutable bytes are verified and decoded, not a mutable caller
    # object. The incumbent trusted verifier must check issuer/key/revocation.
    require(type(receipt) is bytes and 0 < len(receipt) <= 65536 and callable(verify), 'missing_authentic_receipt')
    try:
        require(verify(kind, receipt) is True, 'unverified_receipt')
        data = json.loads(receipt)
        require(encoded(data) == receipt, 'noncanonical_receipt')
        integer(data['not_before']); integer(data['expires'])
        require(data['not_before'] <= now < data['expires'], 'expired_receipt')
        require(data['kind'] == kind, 'receipt_kind')
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise Refused('receipt_shape') from error
    return data


@dataclass(frozen=True)
class Projection:
    previous_head: str
    next_counters: tuple
    next_money: int
    cost: int
    attempt: str
    nonce: str
    binding: str
    # Immutable offline candidates can never be interpreted as send authority.
    can_send: bool = False


def prepare(*, request, wire, policy_receipt, bounds_receipt, verify=None, now,
            current, expected_head, seen_attempts=(), seen_nonces=()):
    """Produce a source-only projection for an incumbent atomic CAS.

    All numbers are integers. Rates charge separately rounded categories;
    discounts are excluded. Unknown attempts remain in current aggregates.
    No implementation here can release a reservation or call a model.
    """
    integer(now)
    shape(request, 'campaign account provider model source_sha256 binary_sha256 journal_id original_ledger_sha256 attempt nonce wire_sha256 policy_sha256 bounds_sha256')
    for key in ('campaign', 'account', 'provider', 'model', 'journal_id', 'attempt', 'nonce'):
        require(type(request[key]) is str and 0 < len(request[key]) <= 256, 'identity_shape')
    for key in ('wire_sha256', 'policy_sha256', 'bounds_sha256', 'source_sha256', 'binary_sha256', 'original_ledger_sha256'):
        hash_value(request[key])
    require(request['original_ledger_sha256'] == ORIGINAL_LEDGER, 'original_ledger_required')
    require(type(wire) is bytes and digest(wire) == request['wire_sha256'], 'wire_binding')
    # Freeze caller input before invoking an external verifier.
    request = dict(request)
    shape(current, 'head counters money currency scale policy_sha256')
    current = dict(current, counters=counters(current['counters']))
    integer(current['money']); integer(current['scale'], positive=True)
    hash_value(expected_head)
    require(current['head'] == expected_head, 'checkpoint_head_mismatch')
    require(request['attempt'] not in seen_attempts and request['nonce'] not in seen_nonces,
            'attempt_or_nonce_replay')
    policy = authenticated(policy_receipt, 'charging-policy', verify, now)
    bounds = authenticated(bounds_receipt, 'wire-bounds', verify, now)
    require(digest(policy_receipt) == request['policy_sha256'] and
            digest(bounds_receipt) == request['bounds_sha256'], 'proof_digest_mismatch')
    shape(policy, 'kind not_before expires campaign account provider model source_sha256 binary_sha256 journal_id original_ledger_sha256 currency scale mode money_cap money_floor retained_counters baseline_head input_rate output_rate fixed_fee no_overage no_fallback')
    shape(bounds, 'kind not_before expires campaign account provider model source_sha256 binary_sha256 journal_id original_ledger_sha256 wire_sha256 input_upper output_upper context_limit output_enforcement all_billable_units')
    for obj in (policy, bounds):
        for key in ('campaign', 'account', 'provider', 'model', 'source_sha256', 'binary_sha256', 'journal_id', 'original_ledger_sha256'):
            require(obj[key] == request[key], 'scope_mismatch')
    require(bounds['wire_sha256'] == request['wire_sha256'], 'bound_wire_mismatch')
    require(bounds['all_billable_units'] is True, 'incomplete_billing_bound')
    require(bounds['output_enforcement'] in ('verified_native_hard_maximum', 'verified_native_limiter'),
            'output_not_enforced')
    inp = integer(bounds['input_upper'], positive=True)
    out = integer(bounds['output_upper'], positive=True)
    require(inp + out <= integer(bounds['context_limit'], positive=True), 'context_overflow')
    require(policy['no_overage'] is True and policy['no_fallback'] is True, 'charging_escape')
    require(type(policy['currency']) is str and re.fullmatch('[A-Z]{3}', policy['currency']), 'currency_shape')
    integer(policy['scale'], positive=True)
    require(current['currency'] == policy['currency'] and current['scale'] == policy['scale'] and
            current['policy_sha256'] == request['policy_sha256'], 'checkpoint_policy_mismatch')
    baseline = counters(policy['retained_counters'])
    require(all(n >= b for n, b in zip(current['counters'], baseline)), 'baseline_regression')
    hash_value(policy['baseline_head'])
    require(policy['currency'] == 'USD' and policy['money_cap'] <= policy['scale'], 'original_dollar_cap')
    cap = integer(policy['money_cap']); floor = integer(policy['money_floor'])
    require(floor <= current['money'] <= cap, 'money_floor_or_cap')
    cost = charge(policy, inp, out)
    next_counters = tuple(n + r for n, r in zip(current['counters'], (1, inp, out)))
    require(all(n <= cap for n, cap in zip(next_counters, CAPS)), 'token_or_attempt_cap')
    require(current['money'] + cost <= cap, 'money_cap')
    binding = digest(encoded({'request': request, 'previous': current,
                              'reserved': [1, inp, out], 'cost': cost}))
    return Projection(expected_head, next_counters, current['money'] + cost,
                      cost, request['attempt'], request['nonce'], binding)


def charge(policy, inp, out):
    """Rational rates in receipt-defined integer currency units per token."""
    integer(inp); integer(out)
    fee = integer(policy['fixed_fee'])
    rates = []
    for key in ('input_rate', 'output_rate'):
        rate = policy[key]
        require(type(rate) is list and len(rate) == 2, 'rate_shape')
        rates.append((integer(rate[0]), integer(rate[1], positive=True)))
    require(policy['mode'] in ('metered', 'subscription_no_incremental_charge'), 'charging_mode')
    if policy['mode'] == 'subscription_no_incremental_charge':
        require(fee == 0 and all(n == 0 for n, _ in rates), 'subscription_nonzero_rate')
    else:
        require(fee > 0 or any(n > 0 for n, _ in rates), 'metered_zero_price')
    total = fee + sum((units * num + den - 1) // den
                      for units, (num, den) in zip((inp, out), rates))
    return integer(total)
