"""Pure source bookkeeping, never a transport, durable store or execution permit.

All references are opaque, unauthenticated digests. Native attempt observation,
provider token enforcement and durable custody must be admitted separately.
"""
from dataclasses import dataclass, replace
import hashlib
import json
import re

from instrument import require, strict_json, verify_zero_callable_tools


CAPS = (528, 10_000_000, 1_500_000)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      allow_nan=False).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def reference(value):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value),
            'reference_shape')


def quantities(value, *, reservation=False):
    require(isinstance(value, tuple) and len(value) == 3 and
            all(type(n) is int and n >= 0 for n in value), 'quantity_shape')
    if reservation:
        require(value[0] == 1 and value[1] > 0 and value[2] > 0,
                'attempt_reservation_shape')
    require(all(n <= cap for n, cap in zip(value, CAPS)), 'cap_exceeded')


@dataclass(frozen=True)
class Attempt:
    request_sha256: str
    reservation: tuple
    bounds_reference: str
    phase: str = 'RESERVED'
    usage: tuple | None = None
    usage_reference: str | None = None
    monetary: bytes | None = None


@dataclass(frozen=True)
class Ledger:
    scope_sha256: str
    baseline: tuple
    baseline_reference: str
    events: tuple = ()  # Canonical bytes: callers cannot mutate previous events.


def initial(scope_sha256, baseline, baseline_reference):
    reference(scope_sha256)
    reference(baseline_reference)
    quantities(baseline)
    require(baseline[0] >= 180, 'historical_consumption_not_preserved')
    return Ledger(scope_sha256, baseline, baseline_reference)


def total(baseline, attempts):
    charged = [a.usage if a.phase == 'RECONCILED' and a.monetary is None else a.reservation
               for a in attempts.values()]
    return tuple(baseline[i] + sum(row[i] for row in charged) for i in range(3))


def identifier(value):
    require(isinstance(value, str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', value),
            'attempt_identifier')


def apply_event(attempts, data, baseline):
    require(isinstance(data, dict), 'event_shape')
    kind = data.get('kind')
    ident = data.get('id')
    identifier(ident)
    if kind in ('reserve', 'reserve_money'):
        expected = {'kind', 'id', 'request', 'reservation', 'bounds'}
        if kind == 'reserve_money':
            expected.add('money')
        else:
            require(not any(a.monetary is not None for a in attempts.values()),
                    'money_projection_required')
        require(set(data) == expected,
                'event_shape')
        require(ident not in attempts, 'duplicate_attempt_event')
        require(all(a.phase != 'UNKNOWN_CONSUMED' for a in attempts.values()),
                'unknown_usage_fence')
        reference(data['request']); reference(data['bounds'])
        amount = tuple(data['reservation']) if isinstance(data['reservation'], list) else None
        quantities(amount, reservation=True)
        money = None
        if kind == 'reserve_money':
            money = validate_money_event(data['money'], attempts, baseline, amount)
        attempts[ident] = Attempt(data['request'], amount, data['bounds'], monetary=money)
    elif kind in ('intent', 'unknown', 'reconcile'):
        expected = {'kind', 'id', 'usage', 'receipt'} if kind == 'reconcile' else {'kind', 'id'}
        require(set(data) == expected and ident in attempts, 'event_shape')
        old = attempts[ident]
        if kind == 'intent':
            require(old.phase == 'RESERVED', 'intent_transition')
            require(all(a.phase != 'UNKNOWN_CONSUMED' for a in attempts.values()),
                    'unknown_usage_fence')
            attempts[ident] = replace(old, phase='FORWARD_INTENT')
        elif kind == 'unknown':
            require(old.phase in ('RESERVED', 'FORWARD_INTENT'), 'unknown_transition')
            attempts[ident] = replace(old, phase='UNKNOWN_CONSUMED')
        else:
            require(old.phase == 'FORWARD_INTENT', 'reconcile_transition')
            amount = tuple(data['usage']) if isinstance(data['usage'], list) else None
            quantities(amount)
            require(amount[0] == 1 and all(n <= cap for n, cap in
                    zip(amount, old.reservation)), 'usage_outside_reservation')
            reference(data['receipt'])
            attempts[ident] = replace(old, phase='RECONCILED', usage=amount, usage_reference=data['receipt'])
    else:
        require(False, 'unknown_event_kind')
    require(all(n <= cap for n, cap in zip(total(baseline, attempts), CAPS)),
            'cap_exceeded')


def fold(ledger):
    require(type(ledger) is Ledger and isinstance(ledger.events, tuple), 'ledger_shape')
    seed = initial(ledger.scope_sha256, ledger.baseline, ledger.baseline_reference)
    previous = digest(encoded({'scope': seed.scope_sha256, 'baseline': seed.baseline,
                               'baseline_reference': seed.baseline_reference, 'caps': CAPS}))
    attempts = {}
    for sequence, raw in enumerate(ledger.events, 1):
        event = strict_json(raw)
        require(isinstance(event, dict) and set(event) == {'seq', 'previous', 'data'},
                'event_envelope')
        require(type(event['seq']) is int and event['seq'] == sequence and
                event['previous'] == previous and encoded(event) == raw, 'event_chain')
        apply_event(attempts, event['data'], ledger.baseline)
        previous = digest(raw)
    return attempts, previous


def append(ledger, data):
    attempts, previous = fold(ledger)
    apply_event(attempts, data, ledger.baseline)
    raw = encoded({'seq': len(ledger.events) + 1, 'previous': previous, 'data': data})
    return Ledger(ledger.scope_sha256, ledger.baseline, ledger.baseline_reference,
                  ledger.events + (raw,))


def reserve(ledger, ident, request_bytes, input_upper_bound, output_cap, bounds_reference):
    identifier(ident)
    shape = verify_zero_callable_tools(request_bytes)
    request = strict_json(request_bytes)
    require(type(request.get('max_output_tokens')) is int and
            request['max_output_tokens'] == output_cap, 'request_output_cap_missing_or_mismatched')
    amount = (1, input_upper_bound, output_cap)
    quantities(amount, reservation=True)
    reference(bounds_reference)
    attempts, _ = fold(ledger)
    old = attempts.get(ident)
    if old is not None:
        require((old.request_sha256, old.reservation, old.bounds_reference) ==
                (shape['request_sha256'], amount, bounds_reference), 'attempt_replay_conflict')
        return ledger  # Recovery of data never permits another send.
    return append(ledger, {'kind': 'reserve', 'id': ident, 'request': shape['request_sha256'],
                          'reservation': list(amount), 'bounds': bounds_reference})


def intent(ledger, ident):
    identifier(ident)
    attempts, _ = fold(ledger)
    require(ident in attempts, 'attempt_missing')
    if attempts[ident].phase == 'FORWARD_INTENT':
        return ledger
    return append(ledger, {'kind': 'intent', 'id': ident})


def unknown(ledger, ident):
    identifier(ident)
    attempts, _ = fold(ledger)
    require(ident in attempts, 'attempt_missing')
    if attempts[ident].phase == 'UNKNOWN_CONSUMED':
        return ledger
    return append(ledger, {'kind': 'unknown', 'id': ident})


def reconcile(ledger, ident, input_tokens, output_tokens, usage_reference):
    identifier(ident)
    quantities((1, input_tokens, output_tokens))
    reference(usage_reference)
    data = {'kind': 'reconcile', 'id': ident, 'usage': [1, input_tokens, output_tokens],
            'receipt': usage_reference}
    attempts, _ = fold(ledger)
    old = attempts.get(ident)
    if old is not None and old.phase == 'RECONCILED':
        require((old.usage, old.usage_reference) ==
                ((1, input_tokens, output_tokens), usage_reference), 'usage_replay_conflict')
        return ledger
    return append(ledger, data)  # Unknown usage is terminal in this source slice.


def observe(ledger):
    attempts, head = fold(ledger)
    used = total(ledger.baseline, attempts)
    return {'schema': 'SourceAccountingObservation/v1', 'source_math': 'verified',
            'scope_sha256': ledger.scope_sha256, 'head_sha256': head,
            'source_charged': used, 'source_remaining': tuple(c - n for c, n in zip(CAPS, used)),
            'unknown_usage': sum(a.phase == 'UNKNOWN_CONSUMED' for a in attempts.values()),
            'event_count': len(ledger.events), 'actual_upstream_accounting': 'NOT_MEASURED',
            'references_authenticated': False, 'durability': 'NOT_MEASURED',
            'runtime_authorized': False, 'accounting_admitted': False, 'model_calls': 0,
            'can_send': False, 'source_money': money_state(attempts)}


def snapshot(ledger):
    fold(ledger)
    return encoded({'schema': 'SourceAccountingSnapshot/v1', 'caps': CAPS,
                    'scope': ledger.scope_sha256, 'baseline': ledger.baseline,
                    'baseline_reference': ledger.baseline_reference,
                    'events': [strict_json(raw) for raw in ledger.events]})


def restore(raw, expected_head_sha256):
    reference(expected_head_sha256)
    doc = strict_json(raw)
    require(isinstance(doc, dict) and set(doc) == {'schema', 'caps', 'scope', 'baseline',
                'baseline_reference', 'events'} and doc['schema'] == 'SourceAccountingSnapshot/v1',
            'snapshot_shape')
    require(doc['caps'] == list(CAPS) and all(type(n) is int for n in doc['caps']),
            'caps_not_immutable')
    require(isinstance(doc['baseline'], list) and isinstance(doc['events'], list),
            'snapshot_shape')
    seed = initial(doc['scope'], tuple(doc['baseline']), doc['baseline_reference'])
    ledger = Ledger(seed.scope_sha256, seed.baseline, seed.baseline_reference,
                    tuple(encoded(event) for event in doc['events']))
    _, actual = fold(ledger)
    require(actual == expected_head_sha256, 'snapshot_head_mismatch')
    return ledger


# Additive source-only monetary events preserve original event/snapshot bytes.
def money_state(attempts):
    rows = [strict_json(item.monetary) for item in attempts.values() if item.monetary is not None]
    if not rows:
        return None
    first = rows[0]
    return {key: first[key] for key in ('currency', 'scale', 'cap', 'floor', 'policy', 'baseline_head')} | {
        'charged': first['floor'] + sum(row['cost'] for row in rows)}


def validate_money_event(row, attempts, baseline, amount):
    import monetary as m
    m.shape(row, 'currency scale cap floor cost policy bounds nonce binding baseline_head')
    for key in ('policy', 'bounds', 'binding', 'baseline_head'):
        reference(row[key])
    identifier(row['nonce'])
    for key in ('scale', 'cap', 'floor', 'cost'):
        m.integer(row[key], positive=(key == 'scale'))
    require(row['currency'] == 'USD' and row['cap'] <= row['scale'], 'original_dollar_cap')
    require(row['floor'] <= row['cap'], 'money_floor_or_cap')
    m.counters(total(baseline, attempts))
    previous = money_state(attempts)
    if previous is not None:
        require(all(row[key] == previous[key] for key in
                    ('currency', 'scale', 'cap', 'floor', 'policy', 'baseline_head')),
                'money_policy_changed')
    nonces = [strict_json(item.monetary)['nonce'] for item in attempts.values()
              if item.monetary is not None]
    require(row['nonce'] not in nonces, 'money_nonce_replay')
    charged = row['floor'] if previous is None else previous['charged']
    require(charged + row['cost'] <= row['cap'], 'money_cap')
    return encoded(row)


def reserve_money(ledger, request, wire, policy_receipt, bounds_receipt, verify=None, now=None):
    """Validate money and tokens before appending ONE source journal event.

    Missing incumbent authority verifier refuses. No issuer or send permit.
    """
    import monetary as m
    import time
    attempts, head = fold(ledger)
    now = int(time.time()) if now is None else now
    policy = m.authenticated(policy_receipt, 'charging-policy', verify, now)
    require(request['campaign'] == ledger.scope_sha256, 'money_campaign_scope')
    previous = money_state(attempts)
    baseline_head = head if previous is None else previous['baseline_head']
    require(policy.get('baseline_head') == baseline_head, 'money_baseline_head')
    used = total(ledger.baseline, attempts)
    if previous is None:
        require(policy['retained_counters'] == list(used), 'money_baseline_counters')
    current = {'head': head, 'counters': used,
               'money': policy['money_floor'] if previous is None else previous['charged'],
               'currency': policy['currency'] if previous is None else previous['currency'],
               'scale': policy['scale'] if previous is None else previous['scale'],
               'policy_sha256': digest(policy_receipt) if previous is None else previous['policy']}
    projection = m.prepare(request=request, wire=wire, policy_receipt=policy_receipt,
                           bounds_receipt=bounds_receipt, verify=verify, now=now, current=current,
                           expected_head=head, seen_attempts=tuple(attempts),
                           seen_nonces=tuple(strict_json(a.monetary)['nonce']
                                             for a in attempts.values() if a.monetary is not None))
    amount = tuple(n - old for n, old in zip(projection.next_counters, used))
    shape = verify_zero_callable_tools(wire)
    parsed = strict_json(wire)
    require(parsed.get('model') == request['model'], 'money_wire_model')
    # prepare authenticated these exact immutable bytes and bound their scope,
    # wire digest, expiry and output upper bound before any event is appended.
    bounds = strict_json(bounds_receipt)
    hard_maximum = ('max_output_tokens' not in parsed and
                    bounds['output_enforcement'] == 'verified_native_hard_maximum' and
                    bounds['output_upper'] == amount[2])
    require(hard_maximum or (type(parsed.get('max_output_tokens')) is int and
            parsed['max_output_tokens'] == amount[2]), 'request_output_cap_missing_or_mismatched')
    row = {'currency': policy['currency'], 'scale': policy['scale'], 'cap': policy['money_cap'],
           'floor': policy['money_floor'], 'cost': projection.cost, 'policy': digest(policy_receipt),
           'bounds': digest(bounds_receipt), 'nonce': request['nonce'], 'binding': projection.binding,
           'baseline_head': baseline_head}
    return append(ledger, {'kind': 'reserve_money', 'id': request['attempt'],
                          'request': shape['request_sha256'], 'reservation': list(amount),
                          'bounds': digest(bounds_receipt), 'money': row})
