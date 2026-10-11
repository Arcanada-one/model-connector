"""Cleanup authority is acquired only from returned Docker IDs, never names."""
import json, os, subprocess, tempfile, unittest
from pathlib import Path
SOURCE = Path(__file__).resolve().parents[1] / 'scripts/app-e2e-disposable.sh'

class Controls(unittest.TestCase):
    def test_create_collision_cannot_delete_guessed_resources(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'bin').mkdir(); (root/'node_modules').mkdir()
            (root/'runner.sh').write_bytes(SOURCE.read_bytes())
            (root/'scripts').mkdir()
            (root/'scripts/app-e2e-snapshot.py').write_bytes((SOURCE.parent/'app-e2e-snapshot.py').read_bytes())
            (root/'pnpm-lock.yaml').write_text('synthetic lock')
            for argv in [['git','init','-q'], ['git','add','runner.sh','scripts','pnpm-lock.yaml'],
                         ['git','-c','user.name=Arcanada','-c','user.email=dev@veritasarcana.ai','commit','-qm','fixture']]:
                subprocess.run(argv,cwd=root,check=True,capture_output=True)
            stub=root/'bin/docker';stub.write_text('''#!/usr/bin/env python3
import sys,json,os
with open(os.environ['TRACE'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
a=sys.argv[1:]
if a[:2]==['image','inspect']:print('sha256:'+'a'*64)
if a[:2]==['network','create']:sys.exit(1)
''');stub.chmod(0o700)
            trace=root/'trace.jsonl'
            result=subprocess.run(['bash','runner.sh'],cwd=root,env={'PATH':str(root/'bin')+':'+os.defpath,'HOME':str(root),'TMPDIR':str(root),'TRACE':str(trace)},capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            calls=[json.loads(x) for x in trace.read_text().splitlines()]
            self.assertTrue(any(x[:2]==['network','create'] for x in calls))
            self.assertFalse(any(x[:1]==['rm'] or x[:2]==['network','rm'] for x in calls))
            self.assertEqual(list(root.glob('mc-app-cid.*')),[])

    def test_cleanup_failure_residual_and_unknown_refuse(self):
        for mode in ('remove-failed', 'residual', 'unknown', 'positive'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                root=Path(folder);(root/'bin').mkdir();(root/'node_modules').mkdir();(root/'scripts').mkdir()
                (root/'runner.sh').write_bytes(SOURCE.read_bytes())
                (root/'scripts/app-e2e-snapshot.py').write_bytes((SOURCE.parent/'app-e2e-snapshot.py').read_bytes())
                (root/'pnpm-lock.yaml').write_text('synthetic lock')
                for argv in [['git','init','-q'],['git','add','runner.sh','scripts','pnpm-lock.yaml'],['git','-c','user.name=Arcanada','-c','user.email=dev@veritasarcana.ai','commit','-qm','fixture']]:
                    subprocess.run(argv,cwd=root,check=True,capture_output=True)
                stub=root/'bin/docker';stub.write_text("""#!/usr/bin/env python3
import sys,os,json
args=sys.argv[1:]; mode=os.environ['MODE']
if args[:2]==['image','inspect']: print('sha256:'+'b'*64)
elif args[:2]==['network','create']: print('c'*64)
elif args[:2]==['network','inspect']: print('true')
elif args[:1]==['run'] and '-d' in args: print(('d' if 'mc-pg' in args else 'e')*64)
elif args[:1]==['exec'] and 'redis-cli' in args: print('PONG')
elif args[:1]==['run'] and '--rm' in args:
 assert all('latest' not in a and ':16' not in a and ':7' not in a for a in args)
 print('APP_E2E_RESULT_BEGIN'); print('{}'); print('APP_E2E_RESULT_END')
elif args[:1]==['rm'] or args[:2]==['network','rm']:
 if mode=='remove-failed': sys.exit(1)
elif args[:1]==['ps'] or args[:2]==['network','ls']:
 if mode=='unknown': sys.exit(124)
 if mode=='residual': print('c'*64)
""");stub.chmod(0o700)
                result=subprocess.run(['bash','runner.sh'],cwd=root,env={'PATH':str(root/'bin')+':'+os.defpath,'HOME':str(root),'TMPDIR':str(root),'MODE':mode},capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode==0,mode=='positive',result.stdout+result.stderr)
                self.assertIn('CLEANUP_FAILED='+('0' if mode=='positive' else '1'),result.stdout)

if __name__ == '__main__': unittest.main()
