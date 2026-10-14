"""Produce genuine immutable rendered-scaffold compiler evidence; no exemption."""
import argparse, hashlib, json, subprocess, sys
from pathlib import Path


def execute(repo, program, scratch, out):
    sys.path.insert(0, str(program / 'tools/graph'))
    import fixture_contracts as upstream
    snapshot = upstream.GitSnapshot.read(repo, 'HEAD')
    producer_path = 'scripts/graph_full_suite.py'
    producer = snapshot.blobs[producer_path]
    namespace = {'__file__': str(repo / producer_path), '__name__': 'committed_renderer'}
    exec(compile(producer.data, str(repo / producer_path), 'exec'), namespace)
    scratch.mkdir(mode=0o700)
    rendered = namespace['render_authored_template'](repo, scratch, [namespace['AUTHORED_TEMPLATE']])
    bindings = []
    for item in rendered['source_bindings']:
        blob = snapshot.blobs[item['path']]
        binding = {'path': item['path'], 'git_blob': blob.oid, 'sha256': item['sha256']}
        upstream.GitSnapshot.bound(snapshot, binding)
        bindings.append(binding)
    bindings.append({'path': producer_path, 'git_blob': producer.oid,
                     'sha256': hashlib.sha256(producer.data).hexdigest()})
    upstream.GitSnapshot.bound(snapshot, bindings[-1])
    outputs = rendered['rendered_files']
    config = scratch/'rendered-tsconfig.json'
    config.write_text(json.dumps({'extends':str(repo/'tsconfig.test.json'),
        'compilerOptions':{'rootDir':'/', 'noEmit':True, 'incremental':False,
                           'typeRoots':[str(repo/'node_modules/@types'),str(repo/'node_modules')]},
        'files':[f['path'] for f in outputs],'include':[],'exclude':[]}))
    argv=['node',str(repo/'node_modules/typescript/bin/tsc'),'-p',str(config),'--pretty','false','--listFiles']
    def compiler():return subprocess.run(argv,cwd=repo,capture_output=True,text=True,timeout=60)
    positive=compiler();(scratch/'compiler-positive.log').write_text(positive.stdout+positive.stderr)
    assert positive.returncode==0, 'Rendered fixture compilation failed'
    assert all(str(Path(f['path']).resolve()) in positive.stdout.splitlines() for f in outputs)
    target=Path(outputs[0]['path']);original=target.read_bytes()
    target.write_bytes(original+b'\nconst fixtureCompilationControl: number = "wrong-type";\n')
    negative=compiler();(scratch/'compiler-negative.log').write_text(negative.stdout+negative.stderr)
    target.write_bytes(original)
    assert negative.returncode!=0 and 'TS2322' in negative.stdout, 'Compiler mutant not rejected'
    bad={**bindings[0],'sha256':'0'*64}
    try:upstream.GitSnapshot.bound(snapshot,bad)
    except upstream.FixtureError as error:
        assert error.code=='DIGEST_MISMATCH';binding_control=error.code
    else:raise AssertionError('Forged input digest accepted')
    for item in outputs:
        path=Path(item['path'])
        assert not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==item['sha256']
    record={'schema':'MCScaffoldRenderedFixtureEvidence/v1','source_commit':snapshot.commit,
            'program_commit':subprocess.check_output(['git','-C',str(program),'rev-parse','HEAD'],text=True).strip(),
            'upstream_primitives':['GitSnapshot.read','GitSnapshot.bound','sample_namespace'],
            'sample_namespace':upstream.sample_namespace('mc-scaffold', 'templates/api-connector-scaffold','head',namespace['AUTHORED_TEMPLATE']),
            'source_bindings':bindings,'rendered_outputs':outputs,'substitutions':rendered['substitutions'],
            'compiler_argv':argv,'compiler_exit':positive.returncode,'listed_outputs':len(outputs),
            'negative_controls':{'wrong_type_exit':negative.returncode,'wrong_type_diagnostic':'TS2322','input_digest':binding_control},
            'native_raw_membership_accepted':False,'admission':'NOT_MEASURED'}
    out.write_text(json.dumps(record,indent=2))
    print('Rendered fixture compiler PASS; syntax/type and immutable-binding controls RED; native receiving ACK required')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--program',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();execute(a.repo.resolve(),a.program.resolve(),a.scratch,a.out)
