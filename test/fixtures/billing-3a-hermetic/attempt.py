"""One source-journal attempt with injected incumbent boundaries, no transport.

No default authority, executor or usage verifier. Callback invocation is not proof
of one physical HTTP attempt: the incumbent native transport must prove that.
All observations remain source-only and reservations are never released.
"""
import accounting as a
from instrument import Refused, require, strict_json


def publish(store, old, new):
    require(new.events[:len(old.events)] == old.events and
            len(new.events) == len(old.events) + 1, 'attempt_transition_shape')
    store._publish(f'event-{len(new.events):06d}.json', new.events[-1])
    return new


def settled(ledger, ident, wire, raw):
    row = strict_json(raw)
    require(isinstance(row, dict) and set(row) ==
            {'attempt', 'wire_sha256', 'input_tokens', 'output_tokens', 'receipt'},
            'attempt_usage_shape')
    require(row['attempt'] == ident and row['wire_sha256'] == a.digest(wire),
            'attempt_usage_binding')
    return a.reconcile(ledger, ident, row['input_tokens'], row['output_tokens'], row['receipt'])


def run_once(store, expected_head, request, wire, policy, bounds, *,
             admit_attempt=None, execute=None, verify_usage=None):
    """Hold existing journal lock across reserve, intent, one callback and outcome.

    admit_attempt verifies the incumbent executor/grant against the immutable
    request, wire and proof bytes plus journal head. verify_usage authenticates
    the response against that same binding. Neither callback is supplied here.
    Failed/ambiguous publication is retained; recovery needs trusted head custody.
    """
    require(all(callable(x) for x in (admit_attempt, execute, verify_usage)),
            'attempt_boundaries_missing')
    request_raw = a.encoded(request)
    request = strict_json(request_raw)
    require(all(type(x) is bytes for x in (wire, policy, bounds)), 'attempt_bytes')
    binding = (request_raw, wire, policy, bounds, expected_head)
    with store._locked():
        old = store._expected(expected_head)
        attempts, _ = a.fold(old)
        require(all(x.phase == 'RECONCILED' for x in attempts.values()),
                'attempt_unresolved_fence')
        require(admit_attempt(binding) is True, 'attempt_authority_refused')
        new = a.reserve_money(old, request, wire, policy, bounds,
                              verify=store.monetary_verifier,
                              now=store.clock() if store.clock else None)
        new = publish(store, old, new)
        ident = request['attempt']
        new = publish(store, new, a.intent(new, ident))
        try:
            # Recheck expiry/custody after durable writes, immediately before call.
            require(admit_attempt(binding) is True, 'attempt_authority_refused')
            raw = execute(wire)
            require(type(raw) is bytes and verify_usage(binding, raw) is True,
                    'attempt_usage_unauthenticated')
            completed = settled(new, ident, wire, raw)
        except BaseException:
            publish(store, new, a.unknown(new, ident))
            raise Refused('attempt_unknown_consumed') from None
        # A failed settle write is ambiguous: retain it, never overwrite or retry.
        completed = publish(store, new, completed)
        return store._observation(completed, 3)
