"""Stateful synthetic Docker receiving controls; no daemon or providers."""
import json, os, subprocess, tempfile, unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[1]/'scripts/app-e2e-disposable.sh'
STUB='''#!/usr/bin/env python3
import json,sys,os
from pathlib import Path
a=sys.argv[1:];root=Path(os.environ['TEST_ROOT']);mode=os.environ['MODE'];file=root/'state.json'
s=json.loads(file.read_text()) if file.exists() else {}
with (root/'trace').open('a') as stream:stream.write(json.dumps(a)+'\\n')
def save():file.write_text(json.dumps(s))
def labels():return dict(x.split('=',1) for i,x in enumerate(a) if i and a[i-1]=='--label')
if a[:2]==['image','inspect']:print('sha256:'+'b'*64)
elif a[:2]==['network','create'] or a[:1]==['run']:
 assert all(x not in a for x in ('postgres:16','redis:7','model-connector-e2e:latest'))
 role=labels()['mc-role']; owner=labels()['mc-run']; name=a[-1] if role=='network' else a[a.index('--name')+1]
 intents=list(root.glob('mc-app-cid.*/'+role+'.intent.json'))
 assert len(intents)==1 and json.loads(intents[0].read_text())['state']=='in_flight'
 if mode=='foreign-collision' or mode=='foreign-collision-'+role:
  s['f'*64]={'Id':'f'*64,'Name':name,'Labels':{'mc-run':'foreign','mc-role':role}};save();sys.exit(1)
 if role=='app':
  if mode=='unix-init-ready' and not json.loads((root/'readiness.json').read_text())['tcp_ready']:sys.exit(27)
  print('APP_E2E_RESULT_BEGIN');print('{}');print('APP_E2E_RESULT_END');sys.exit(0)
 identity={'network':'c','pg':'d','redis':'e'}[role]*64
 obj={'Id':identity,'Name':name,'Labels':labels(),'Config':{'Labels':labels()}};s[identity]=obj;save()
 if mode in ('lost-'+role,'lost-hidden'):sys.exit(124)
 print(identity)
elif a[:2]==['network','inspect'] and '--format' in a:print('true')
elif a[:1]==['inspect'] or a[:2]==['network','inspect']:print(json.dumps([s[a[-1]]]))
elif a[:1]==['exec'] and 'pg_isready' in a:
 if mode=='unix-init-ready':
  ready=root/'readiness.json';observation=json.loads(ready.read_text()) if ready.exists() else {'checks':0,'tcp_ready':False}
  if '-h' not in a:
   ready.write_text(json.dumps(observation));sys.exit(0)
  assert a[a.index('-h')+1]=='127.0.0.1'
  observation['checks']+=1;observation['tcp_ready']=observation['checks']>=2;ready.write_text(json.dumps(observation))
  sys.exit(0 if observation['tcp_ready'] else 1)
elif a[:1]==['exec'] and 'redis-cli' in a:print('PONG')
elif a[:1]==['ps'] or a[:2]==['network','ls']:
 if mode=='unknown':sys.exit(124)
 if mode=='lost-hidden':sys.exit(0)
 filters=[a[i+1][6:].split('=',1) for i,x in enumerate(a) if x=='--filter']
 for identity,obj in s.items():
  if all(obj['Labels'].get(k)==v for k,v in filters):print(identity)
elif a[:1]==['rm'] or a[:2]==['network','rm']:
 identity=a[-1];assert s[identity]['Labels']['mc-run']!='foreign'
 if mode=='remove-failed':sys.exit(1)
 del s[identity];save()
'''
class Controls(unittest.TestCase):
 def run_case(self, mode):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);(root/'bin').mkdir();(root/'node_modules').mkdir();(root/'scripts').mkdir()
   (root/'runner.sh').write_bytes(SOURCE.read_bytes());(root/'pnpm-lock.yaml').write_text('synthetic lock')
   for helper in ('app-e2e-snapshot.py','app-e2e-reconcile.py'):(root/'scripts'/helper).write_bytes((SOURCE.parent/helper).read_bytes())
   for args in [('init','-q'),('add','runner.sh','scripts','pnpm-lock.yaml'),('-c','user.name=Arcanada','-c','user.email=dev@veritasarcana.ai','commit','-qm','fixture')]:subprocess.run(['git',*args],cwd=root,check=True,capture_output=True)
   stub=root/'bin/docker';stub.write_text(STUB);stub.chmod(0o700)
   r=subprocess.run(['bash','runner.sh'],cwd=root,env={'PATH':str(root/'bin')+':'+os.defpath,'HOME':str(root),'TMPDIR':str(root),'TEST_ROOT':str(root),'MODE':mode},capture_output=True,text=True,timeout=15)
   state=json.loads((root/'state.json').read_text());retained=list(root.glob('mc-app-cid.*'))
   if mode in ('positive','unix-init-ready','lost-network','lost-pg','lost-redis'):
    self.assertEqual(r.returncode,0 if mode in ('positive','unix-init-ready') else 124,r.stdout+r.stderr)
    self.assertEqual(state,{});self.assertFalse(retained);self.assertIn('CLEANUP_FAILED=0',r.stdout)
   else:
    self.assertNotEqual(r.returncode,0);self.assertTrue(retained);self.assertIn('CLEANUP_FAILED=1',r.stdout)
    self.assertEqual(json.loads((retained[0]/'cleanup.json').read_text())['verdict'],'UNKNOWN')
   calls=[json.loads(x) for x in (root/'trace').read_text().splitlines()]
   self.assertFalse(any(x[-1]=='f'*64 and (x[0]=='rm' or x[:2]==['network','rm']) for x in calls))
   if mode=='unix-init-ready':
    ready_calls=[a for a in calls if 'pg_isready' in a]
    self.assertEqual(len(ready_calls),2)
    self.assertTrue(all(a[a.index('-h')+1]=='127.0.0.1' for a in ready_calls))
 def test_waits_for_tcp_after_unix_init_server_reports_ready(self):
  self.run_case('unix-init-ready')
 def test_lost_response_network_and_stores_reconcile_exclusive_ownership(self):
  for mode in ('positive','lost-network','lost-pg','lost-redis'):
   with self.subTest(mode=mode):self.run_case(mode)
 def test_unknown_and_foreign_collision_preserve_custody(self):
  for mode in ('lost-hidden','unknown','remove-failed','foreign-collision','foreign-collision-pg','foreign-collision-redis'):
   with self.subTest(mode=mode):self.run_case(mode)
if __name__=='__main__':unittest.main()
