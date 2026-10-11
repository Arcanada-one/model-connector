"""Independent current-source crash control. Preparation/evaluation only.

No measurement launcher, provider adapter or execution admission is supplied.
An admitted external executor must run each prepared instrument in its own
namespace; this comparator and any expected data must be absent there.
"""
import argparse
import hashlib
import json
from pathlib import Path

CANDIDATE_SHA = 'f73e71c06980493ab0e2d25448cca9420128d778e9c29e2c5b18a82fe0014c51'
RESERVE = "    ledger.reserve('crashed', manifest['pins'])\n"
OMITTED = "    pass  # PLANTED FAULT: committed reservation omitted before crash barrier\n"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def prepare(candidate, output):
    raw = Path(candidate).read_bytes()
    if sha(raw) != CANDIDATE_SHA:
        raise ValueError('wrong current candidate bytes')
    text = raw.decode()
    if text.count(RESERVE) != 1:
        raise ValueError('fault site is not unique')
    mutant = text.replace(RESERVE, OMITTED).encode()
    compile(raw, 'positive.py', 'exec')
    compile(mutant, 'reserve-omitted.py', 'exec')
    root = Path(output)
    root.mkdir(mode=0o700, exist_ok=False)
    records = []
    for name, data in [('positive.py', raw), ('reserve-omitted.py', mutant)]:
        (root / name).write_bytes(data)
        records.append({'path': name, 'sha256': sha(data)})
    manifest = {'schema': 'IndependentCrashControlPreparation/v1',
                'MC_head': '3493ea2460de772f7a0b6813908ca02117c5f60f',
                'instrument_variants': records,
                'measurement_executed': False, 'execution_admission': None,
                'fault': 'Omit actual child reserve; keep real ledger, barrier, owned kill and reopen unchanged.',
                'required_executor_boundary': 'Only instrument and pinned ledger dependencies visible to child; no comparator/oracle/other variant. Separate fresh owned directories; no provider or live DB.'}
    (root / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
    return manifest


def accepts_crash_observation(observation):
    """Compare genuine candidate output only; never writes observation fields."""
    problems = []
    if observation.get('schema') != 'MCActualCrashLedgerObservation/v1':
        problems.append('wrong observation schema')
    if observation.get('child_exit_code') != -9:
        problems.append('owned child abrupt SIGKILL not established')
    if observation.get('same_ledger_identity') is not True:
        problems.append('same ledger identity not established')
    if observation.get('invocation_marker_present') is not False:
        problems.append('unexpected invocation or missing marker observation')
    if observation.get('dispatch_refusal') != 'unresolved_or_concurrent_attempt':
        problems.append('wrong refusal; generic failure is insufficient')
    for field in ('before_next_dispatch', 'after_next_dispatch'):
        state = observation.get(field, {})
        attempts = state.get('attempts', [])
        expected = [('crashed', 1, 'reserved', None), ('next', 1, 'scheduled', None)]
        actual = [(x.get('id'), x.get('bound'), x.get('state'), x.get('settled')) for x in attempts]
        if actual != expected:
            problems.append(field + ': wrong durable attempts')
        if (state.get('ceiling_micro_usd'), state.get('reserved_micro_usd'),
                state.get('settled_micro_usd'), state.get('remaining_micro_usd')) != (2, 1, 0, 1):
            problems.append(field + ': exposure not retained')
    if observation.get('before_next_dispatch', {}).get('aborted') is not None:
        problems.append('unexpected pre-recovery abort')
    if observation.get('after_next_dispatch', {}).get('aborted') != 'unresolved_or_concurrent_attempt':
        problems.append('abort not persisted')
    return problems


def evaluate(manifest_path, positive_path, mutant_path):
    """External receiving envelopes are evidence, not self-authenticating authority."""
    manifest = json.loads(Path(manifest_path).read_text())
    variants = {x['path']: x['sha256'] for x in manifest['instrument_variants']}
    results = {}
    for name, path in [('positive.py', positive_path), ('reserve-omitted.py', mutant_path)]:
        envelope = json.loads(Path(path).read_text())
        if envelope.get('instrument_sha256') != variants[name]:
            raise ValueError('wrong measured source binding: ' + name)
        if not envelope.get('execution_receipt_ref'):
            raise ValueError('missing independent executor receipt: ' + name)
        # Authenticity and admission must be verified by the canonical receiver;
        # these string/shape checks cannot do that or grant runtime authority.
        results[name] = accepts_crash_observation(envelope['observation'])
    # A malformed/missing negative result is not detection of the planted fault.
    mutant = json.loads(Path(mutant_path).read_text())['observation']
    structural = (mutant.get('schema') == 'MCActualCrashLedgerObservation/v1'
                  and mutant.get('child_exit_code') == -9
                  and mutant.get('same_ledger_identity') is True
                  and mutant.get('invocation_marker_present') is False
                  and mutant.get('dispatch_refusal') == 'duplicate_or_out_of_order')
    for field in ('before_next_dispatch', 'after_next_dispatch'):
        state = mutant.get(field, {})
        actual = [(x.get('id'), x.get('bound'), x.get('state'), x.get('settled'))
                  for x in state.get('attempts', [])]
        structural = structural and actual == [('crashed', 1, 'scheduled', None), ('next', 1, 'scheduled', None)]
        structural = structural and (state.get('ceiling_micro_usd'), state.get('reserved_micro_usd'), state.get('settled_micro_usd'), state.get('remaining_micro_usd')) == (2, 0, 0, 2)
    structural = structural and mutant.get('before_next_dispatch', {}).get('aborted') is None
    structural = structural and mutant.get('after_next_dispatch', {}).get('aborted') == 'duplicate_or_out_of_order'
    qualified = not results['positive.py'] and bool(results['reserve-omitted.py']) and structural
    return {'schema': 'IndependentCrashControlComparison/v1',
            'positive_problems': results['positive.py'],
            'planted_fault_problems': results['reserve-omitted.py'],
            'comparison_pass': qualified, 'planted_fault_observation_complete': structural,
            'claim_scope': 'Crash reservation retention comparator only; not DIAG16, cap-removal, production or provider proof.',
            'execution_receipt_authenticity': 'REQUIRES_CANONICAL_RECEIVER'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('candidate'); prep.add_argument('output')
    compare = sub.add_parser('evaluate')
    compare.add_argument('manifest'); compare.add_argument('positive'); compare.add_argument('mutant')
    args = parser.parse_args()
    result = prepare(args.candidate, args.output) if args.command == 'prepare' else evaluate(args.manifest, args.positive, args.mutant)
    print(json.dumps(result, indent=2))
    if args.command == 'evaluate' and not result['comparison_pass']:
        raise SystemExit(1)
