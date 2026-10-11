"""Receive immutable scaffold compiler evidence without granting native exemption."""
import argparse, hashlib, json, sys
from pathlib import Path


def receive(repo, program, evidence, owned):
    sys.path.insert(0, str(program / 'tools/graph'))
    import fixture_contracts as upstream
    doc = upstream.strict_json(evidence.read_bytes())
    if doc['schema'] != 'MCScaffoldRenderedFixtureEvidence/v1':
        raise ValueError('unsupported scaffold evidence schema')
    snapshot = upstream.GitSnapshot.read(repo, doc['source_commit'])
    for binding in doc['source_bindings']:
        upstream.GitSnapshot.bound(snapshot, binding)
    current = upstream.GitSnapshot.read(repo, 'HEAD')
    for binding in doc['source_bindings']:
        upstream.GitSnapshot.bound(current, binding)
    if doc['compiler_exit'] != 0 or doc['listed_outputs'] != 2:
        raise ValueError('missing compiler membership/positive execution')
    namespace = {'__file__': str(repo / 'scripts/graph_full_suite.py'), '__name__': 'immutable_receiver'}
    exec(compile(snapshot.blobs['scripts/graph_full_suite.py'].data, namespace['__file__'], 'exec'), namespace)
    replay = owned / 'receiving-replay'
    replay.mkdir(mode=0o700)
    expected = namespace['render_authored_template'](repo, replay, [namespace['AUTHORED_TEMPLATE']])
    hashes = {row['source']: row['sha256'] for row in expected['rendered_files']}
    if len(doc['rendered_outputs']) != 2 or {x['source'] for x in doc['rendered_outputs']} != set(hashes):
        raise ValueError('rendered source inventory mismatch')
    for row in doc['rendered_outputs']:
        path = Path(row['path'])
        if path.is_symlink() or not path.resolve().is_relative_to(owned.resolve()):
            raise ValueError('rendered output escapes owned scope')
        if row['sha256'] != hashes[row['source']] or hashlib.sha256(path.read_bytes()).hexdigest() != hashes[row['source']]:
            raise ValueError('rendered output/provenance mismatch')
    return {'source_commit': snapshot.commit, 'source_bindings': len(doc['source_bindings']),
            'reconstructed_outputs': len(hashes), 'verdict': 'verified_rendered_fixture_only',
            'native_raw_membership_accepted': False}

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--program',type=Path,required=True);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--owned',type=Path,required=True)
    a=p.parse_args();print(json.dumps(receive(a.repo.resolve(),a.program.resolve(),a.evidence,a.owned)))
