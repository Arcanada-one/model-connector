"""Existing-Journal monetary custodian; no ledger creation, transport or release.

The incumbent receiver owns authenticated caller/grant admission and signing.
This function implements its atomic callback against the supplied Journal.
An unsigned witness is returned only after both liabilities and UNKNOWN are
durable. Any incomplete prefix remains on disk and fences another invocation.
"""
import accounting as a
import monetary as m
from attempt import publish
from instrument import require, strict_json


UNITS = ['attempts', 'qualified_utf8_bytes_input_token_upper_bound_charge',
         'qualified_model_output_token_upper_bound']
OUTER = set(('campaign account provider model source_sha256 binary_sha256 '
             'journal_id attempt nonce wire_sha256 schema subject accounting_schema '
             'reserved_units wire_utf8_bytes input_token_upper_bound input_policy '
             'output_policy bounds_proof_sha256 reserved caps retained_baseline '
             'monetary_request monetary_checkpoint_head_sha256').split())


def validate_request(request, wire, bounds):
    require(type(request) is dict and set(request) == OUTER, 'custodian_request_shape')
    money = request['monetary_request']
    m.shape(money, 'campaign account provider model source_sha256 binary_sha256 journal_id '
            'original_ledger_sha256 attempt nonce wire_sha256 policy_sha256 bounds_sha256')
    require(request['schema'] == 'NativeBenchReservationRequest/v2' and
            request['accounting_schema'] == 'NativeBenchAccounting/v2' and
            request['reserved_units'] == UNITS, 'custodian_version')
    for key in OUTER & set(money):
        require(request[key] == money[key], 'custodian_scope')
    require(money['provider'] == 'chatgpt-subscription' and
            money['model'] == 'gpt-6-luna', 'custodian_route')
    m.hash_value(money['nonce']); m.hash_value(request['bounds_proof_sha256'])
    require(type(request['subject']) is str and 0 < len(request['subject']) <= 256,
            'custodian_subject')
    require(request['input_policy'] == 'TEXT_ONLY_UTF8_BYTES_UPPER_BOUND' and
            request['output_policy'] == 'AUTHENTICATED_MODEL_HARD_MAXIMUM_NO_RELEASE',
            'custodian_bound_policy')
    require(type(request['reserved']) is list, 'custodian_reserved')
    a.quantities(tuple(request['reserved']), reservation=True)
    require(request['caps'] == list(a.CAPS) and
            all(type(n) is int for n in request['caps']), 'custodian_caps')
    m.counters(request['retained_baseline'])
    require(all(type(request[k]) is int and request[k] == len(wire)
                for k in ('wire_utf8_bytes', 'input_token_upper_bound')) and
            request['reserved'] == [1, len(wire), bounds['output_upper']] and
            bounds['input_upper'] == len(wire) and
            bounds['output_enforcement'] == 'verified_native_hard_maximum',
            'custodian_qualified_bounds')
    return money


def reserve_atomic(store, request, wire, policy, bounds, *, deadline_unix,
                   admit=None):
    """admit authenticates frozen (request,wire,policy,bounds,deadline) each time.

    It must bind the original caller, issuer and this existing Journal instance;
    there is no default admission or automatic initialization. The same incumbent
    proof verifier is also called by reserve_money, before any publication.
    Deadline and authority are checked under the lock before and after fsync.
    """
    require(callable(admit) and callable(store.clock) and
            callable(store.monetary_verifier), 'custodian_boundaries_missing')
    require(all(type(x) is bytes for x in (wire, policy, bounds)), 'custodian_bytes')
    frozen = a.encoded(request)
    request = strict_json(frozen)
    m.integer(deadline_unix)
    started = store.clock(); m.integer(started)
    require(started < deadline_unix <= started + 5, 'custodian_deadline')
    binding = (frozen, wire, policy, bounds, deadline_unix)

    def fresh():
        now = store.clock(); m.integer(now)
        require(started <= now < deadline_unix, 'custodian_expired')
        require(admit(binding) is True, 'custodian_authority_refused')
        # The authority check may itself consume time.
        now = store.clock(); m.integer(now)
        require(started <= now < deadline_unix, 'custodian_expired')
        return now

    with store._locked():
        now = fresh()
        old = store._expected(request.get('monetary_checkpoint_head_sha256'))
        attempts, previous_head = a.fold(old)
        require(all(x.phase == 'RECONCILED' for x in attempts.values()),
                'custodian_unresolved_fence')
        bound = m.authenticated(bounds, 'wire-bounds', store.monetary_verifier, now)
        money = validate_request(request, wire, bound)
        new = a.reserve_money(old, money, wire, policy, bounds,
                              verify=store.monetary_verifier, now=now)
        policy_doc = strict_json(policy)  # exact bytes authenticated above
        require(deadline_unix <= min(policy_doc['expires'], bound['expires']),
                'custodian_proof_deadline')
        require(all(n >= floor for n, floor in
                    zip(policy_doc['retained_counters'], request['retained_baseline'])),
                'custodian_retained_baseline')
        before = a.total(old.baseline, attempts)
        fresh()  # Includes proof-verification time; no expired publication.
        new = publish(store, old, new)  # ONE event reserves BOTH liabilities.
        new = publish(store, new, a.unknown(new, money['attempt']))
        # Failure from here retains UNKNOWN and every reserved unit; no refund.
        fresh()
        states, head = a.fold(new)
        event_money = strict_json(states[money['attempt']].monetary)
        aggregate = a.total(new.baseline, states)
        next_money = a.money_state(states)['charged']
        witness = dict(schema='NativeBenchMonetaryReservation/v1', request=money,
                       currency=event_money['currency'], scale=event_money['scale'],
                       cap=event_money['cap'], floor=event_money['floor'],
                       previous_money=next_money-event_money['cost'],
                       cost=event_money['cost'], next_money=next_money,
                       counters_before=list(before), previous_head_sha256=previous_head,
                       head_sha256=head, projection_binding_sha256=event_money['binding'])
        result = dict(valid_until_unix=deadline_unix, request=request,
                      sequence=aggregate[0], aggregate=list(aggregate),
                      previous_head_sha256=previous_head, head_sha256=head,
                      durable_verdict='ATOMIC_FSYNC_RESERVED_UNKNOWN_NO_RELEASE',
                      monetary=witness)
    return result  # _locked has checked the Journal anchor again before return.
