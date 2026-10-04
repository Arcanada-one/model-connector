"""Offline synthetic-only bridge fixture; never an installed Journal executor.

The existing Billing modules and store are externally pinned. Only the test
bootstrap mode initializes a temporary Journal. Normal stdin reservation mode
opens the existing one and uses the independently supplied private FD3 binding.
"""
import hashlib
import json
import os
from pathlib import Path
import sys


def main():
    context = json.loads(os.fdopen(3).read())
    assert context['fixture_only'] is True
    source = Path(context['module_dir'])
    for name, expected in context['module_pins'].items():
        assert hashlib.sha256((source/name).read_bytes()).hexdigest() == expected
    sys.path.insert(0, str(source))
    import accounting as a
    import journal as j
    import monetary as m
    import custodian as c
    from proofs import PinnedProofVerifier
    store = Path(context['store'])
    if context['mode'] == 'bootstrap_fixture':
        with j.Journal(store) as journal:
            result = journal.initialize(a.initial('1'*64, m.FLOOR, '2'*64))
        print(json.dumps({'head': result['head_sha256']}))
        return
    if context['mode'] == 'observe_fixture':
        with j.Journal(store) as journal:
            result = a.observe(journal._load())
        print(json.dumps({'unknown': result['unknown_usage'],
                          'events': result['event_count'],
                          'counters': result['source_charged'],
                          'money': result.get('source_money')}))
        return
    raw = sys.stdin.buffer.read(11000000)
    value = json.loads(raw)
    assert set(value) == {'request', 'wire_utf8', 'charging_policy_utf8',
                          'wire_bounds_utf8', 'deadline_unix'}
    # Actual process metadata check: full wire/proof bodies may never be argv.
    argv = Path('/proc/self/cmdline').read_bytes()
    assert value['wire_utf8'].encode() not in argv
    assert value['charging_policy_utf8'].encode() not in argv
    expected = context['expected']
    assert a.encoded(value) == a.encoded(expected)
    verifier = PinnedProofVerifier(bytes.fromhex(context['public_der_hex']),
        context['issuer_digest'],
        {k: bytes.fromhex(v) for k, v in context['signatures'].items()})
    wire = value['wire_utf8'].encode()
    policy = value['charging_policy_utf8'].encode()
    bounds = value['wire_bounds_utf8'].encode()
    binding = (a.encoded(value['request']), wire, policy, bounds, value['deadline_unix'])
    with j.Journal(store, monetary_verifier=verifier,
                   clock=lambda: context['synthetic_clock']) as journal:
        if context.get('late_after_unknown'):
            original = journal._publish
            def late(name, body):
                original(name, body)
                if name == 'event-000002.json':
                    context['synthetic_clock'] = value['deadline_unix']
            journal._publish = late
        receipt = c.reserve_atomic(journal, value['request'], wire, policy, bounds,
            deadline_unix=value['deadline_unix'], admit=lambda actual: actual == binding)
    print(json.dumps(receipt))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never emit untrusted request/exception bodies, even in this fixture.
        sys.exit(2)
