"""Owned source-receiving fixtures, never a privileged installer/provider admission."""
import hashlib,json,os,subprocess,tempfile,unittest
from pathlib import Path
SOURCE=Path(__file__).with_name('broker-install-main.sh').read_text()
DEPLOY=Path(__file__).with_name('deploy.sh').read_text()
class StockMainRoute(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='owned-stock-broker-');self.root=Path(self.temp.name);(self.root/'deploy').mkdir();self.installed=self.root/'installed';self.called=self.root/'called'
  self.broker=self.root/'deploy/arcanada-compose-broker.sh';self.broker.write_text('#!/bin/bash\n# owned fixture broker\n');self.sha=hashlib.sha256(self.broker.read_bytes()).hexdigest()
  installer=self.root/'deploy/install-arcanada-compose-broker.sh';installer.write_text('#!/bin/bash\nset -eu\nif [[ "${1:-}" == --restore ]]; then expected="$2"; else expected="$1"; fi\n[[ "$expected" == "'+self.sha+'" ]] || exit 7\ncp "'+str(self.broker)+'" "'+str(self.installed)+'"\nprintf x >> "'+str(self.called)+'"\n')
  source=SOURCE.replace('readonly ROOT=/var/lib/arcanada-deploy/model-connector','readonly ROOT='+str(self.root)).replace('"$(id -u)" -eq 0','"$(id -u)" -eq '+str(os.getuid())).replace('for parent in /var /var/lib /var/lib/arcanada-deploy "$ROOT" "$ROOT/deploy";','for parent in "$ROOT" "$ROOT/deploy";').replace('== root','== '+subprocess.check_output(['id','-un'],text=True).strip()).replace('/usr/local/sbin/arcanada-compose-broker',str(self.installed))
  (self.root/'deploy/broker-install-main.sh').write_text(source);(self.root/'deploy/deploy.sh').write_text(DEPLOY);self.request=self.root/'deploy/broker-install-only.request';self.request.write_text('install:'+self.sha+'\n')
  self.git('init','-q');self.git('add','.');self.git('-c','user.name=Arcanada','-c','user.email=test@example.invalid','commit','-qm','owned fixture');self.git('update-ref','refs/remotes/origin/main','HEAD')
 def tearDown(self):self.temp.cleanup()
 def git(self,*args):return subprocess.check_output(['git',*args],cwd=self.root,stderr=subprocess.DEVNULL)
 def run_route(self):return subprocess.run(['/usr/bin/bash',str(self.root/'deploy/deploy.sh')],capture_output=True,timeout=5)
 def commit_request(self):self.git('add','deploy/broker-install-only.request');self.git('-c','user.name=Arcanada','-c','user.email=test@example.invalid','commit','-qm','owned request');self.git('update-ref','refs/remotes/origin/main','HEAD')
 def test_install_exits_before_app_env(self):
  r=self.run_route();self.assertEqual(r.returncode,0);self.assertIn(b'BROKER_STOCK_MAIN_install_PASS',r.stdout);self.assertFalse((self.root/'.env').exists());self.assertEqual(self.called.read_bytes(),b'x')
 def test_restore_uses_stock_retained_generation(self):
  self.request.write_text('restore:'+self.sha+'\n');self.commit_request();r=self.run_route();self.assertEqual(r.returncode,0);self.assertIn(b'BROKER_STOCK_MAIN_restore_PASS',r.stdout)
 def test_dirty_source_refuses(self):
  self.broker.write_text('changed\n');self.assertNotEqual(self.run_route().returncode,0);self.assertFalse(self.called.exists())
 def test_unreachable_main_refuses(self):
  self.git('update-ref','-d','refs/remotes/origin/main');self.assertNotEqual(self.run_route().returncode,0);self.assertFalse(self.called.exists())
 def test_symlink_request_refuses(self):
  self.request.unlink();self.request.symlink_to(self.root/'absent');self.assertNotEqual(self.run_route().returncode,0);self.assertFalse(self.called.exists())
 def test_untracked_request_refuses(self):
  self.git('rm','--cached','deploy/broker-install-only.request');self.git('-c','user.name=Arcanada','-c','user.email=test@example.invalid','commit','-qm','no source request');self.git('update-ref','refs/remotes/origin/main','HEAD');self.assertNotEqual(self.run_route().returncode,0);self.assertFalse(self.called.exists())
 def test_symlink_recipe_refuses(self):
  helper=self.root/'deploy/broker-install-main.sh';helper.unlink();helper.symlink_to(self.root/'absent');self.assertNotEqual(self.run_route().returncode,0);self.assertFalse(self.called.exists())
 def test_wrong_source_pin_refuses(self):
  self.request.write_text('install:'+'0'*64+'\n');self.commit_request();self.assertNotEqual(self.run_route().returncode,0);self.assertFalse(self.called.exists())
 def test_trailing_bytes_refuse(self):
  self.request.write_text('install:'+self.sha+'\nextra');self.commit_request();self.assertNotEqual(self.run_route().returncode,0);self.assertFalse(self.called.exists())
 def test_unknown_action_refuses(self):
  self.request.write_text('grant:'+self.sha+'\n');self.commit_request();self.assertNotEqual(self.run_route().returncode,0);self.assertFalse(self.called.exists())
 def test_actual_unprivileged_caller_refuses(self):
  script=self.root/'actual.sh';script.write_text(SOURCE);r=subprocess.run(['/usr/bin/bash',str(script)],capture_output=True,timeout=2);self.assertNotEqual(r.returncode,0);self.assertIn(b'REFUSED_ACTOR',r.stderr);self.assertFalse(self.called.exists())
if __name__=='__main__':unittest.main()
