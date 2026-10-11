"""Cleanup authority is acquired only from returned Docker IDs, never names."""
import json, os, subprocess, tempfile, unittest
from pathlib import Path
SOURCE = Path(__file__).resolve().parents[1] / 'scripts/app-e2e-disposable.sh'

class Controls(unittest.TestCase):
    def test_create_collision_cannot_delete_guessed_resources(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'bin').mkdir(); (root/'node_modules').mkdir()
            (root/'runner.sh').write_bytes(SOURCE.read_bytes())
            for argv in [['git','init','-q'], ['git','add','runner.sh'],
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

if __name__ == '__main__': unittest.main()
