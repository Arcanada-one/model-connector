"""Receive immutable scaffold compiler evidence without granting native exemption."""
import argparse, hashlib, json, subprocess, sys
from pathlib import Path


def receive(repo, program, evidence, owned):
    sys.path.insert(0, str(program / 'tools/graph'))
    import fixture_contracts as upstream
    doc = upstream.strict_json(evidence.read_bytes())
    if doc['schema'] != 'MCScaffoldRenderedFixtureEvidence/v1':
        raise ValueError('unsupported scaffold evidence schema')
    required = {'templates/api-connector-scaffold/README.md',
                'templates/api-connector-scaffold/{{name}}.connector.ts',
                'templates/api-connector-scaffold/{{name}}.connector.spec.ts',
                'vitest.config.ts', 'src/connectors/base-api.connector.ts',
                'src/connectors/interfaces/connector.interface.ts',
                'scripts/graph_full_suite.py'}
    rows = doc['source_bindings']
    if len(rows) != len(required) or {r['path'] for r in rows} != required:
        raise ValueError('missing, duplicate or additional rendering input closure')
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
    # Execute an independently constructed compiler invocation; sender fields are
    # assertions, never an execution qualification or an arbitrary argv grant.
    config = replay / 'receiving-tsconfig.json'
    config.write_text(json.dumps({'extends':str(repo/'tsconfig.test.json'),
        'compilerOptions':{'rootDir':'/', 'noEmit':True, 'incremental':False,
                           'typeRoots':[str(repo/'node_modules/@types'),str(repo/'node_modules')]},
        'files':[r['path'] for r in expected['rendered_files']], 'include':[], 'exclude':[]}))
    compiler = repo / 'node_modules/typescript/bin/tsc'
    argv = ['node', str(compiler), '-p', str(config), '--pretty', 'false', '--listFiles']
    execution = subprocess.run(argv, cwd=repo, capture_output=True, text=True, timeout=60)
    (replay/'compiler.log').write_text(execution.stdout+execution.stderr)
    if execution.returncode or any(str(Path(r['path']).resolve()) not in execution.stdout.splitlines()
                                  for r in expected['rendered_files']):
        raise ValueError('receiver compiler failed or omitted rendered output')
    identity = {'argv':argv, 'exit_code':execution.returncode,
                'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),
                'config_sha256':hashlib.sha256(config.read_bytes()).hexdigest()}
    return {'receiving_execution': identity, 'source_commit': snapshot.commit, 'source_bindings': len(doc['source_bindings']),
            'reconstructed_outputs': len(hashes), 'verdict': 'verified_rendered_fixture_only',
            'native_raw_membership_accepted': False}

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--program',type=Path,required=True);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--owned',type=Path,required=True)
    a=p.parse_args();print(json.dumps(receive(a.repo.resolve(),a.program.resolve(),a.evidence,a.owned)))
