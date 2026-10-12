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
 def test_status_query_failure_refuses_before_installer(self):
  shim=self.root/'git-shim';shim.write_text('#!/bin/bash\nif [[ "${3:-}" == status ]]; then exit 128; fi\nexec /usr/bin/git "$@"\n');shim.chmod(0o700)
  recipe=self.root/'deploy/broker-install-main.sh';recipe.write_text(recipe.read_text().replace('/usr/bin/git -C',str(shim)+' -C'));self.git('add','deploy/broker-install-main.sh');self.git('-c','user.name=Arcanada','-c','user.email=test@example.invalid','commit','-qm','owned status failure fixture');self.git('update-ref','refs/remotes/origin/main','HEAD')
  r=self.run_route();self.assertNotEqual(r.returncode,0);self.assertIn(b'REFUSED_STATUS_QUERY',r.stderr);self.assertFalse(self.called.exists())
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
class FixedDeployEnvironment(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='owned-deploy-env-');self.root=Path(self.temp.name)
  self.marker=self.root/'startup-called';self.child=self.root/'child.sh'
  self.child.write_text('printf "PATH=%s\\nHOME=%s\\nLANG=%s\\nTAINT=%s\\n" "$PATH" "${HOME-}" "${LANG-}" "${CALLER_TAINT-}"\n')
  self.startup=self.root/'startup.sh';self.startup.write_text('printf x >> "'+str(self.marker)+'"\n')
  raw=Path(__file__).with_name('arcanada-compose-broker.sh').read_text()
  self.function=raw.split('cmd_run_deploy() {',1)[1].split('\n}\n',1)[0]
 def tearDown(self):self.temp.cleanup()
 def run_function(self,service='model-connector',old=False,missing=False):
  function=self.function
  if old:
   start=function.index('  case "$svc" in\n')
   end=function.index('\n  esac',start)+len('\n  esac')
   function=function[:start]+'  ( cd "$dir" && bash "$script" )'+function[end:]
  script='declare -A SCRIPT=([model-connector]=child.sh [other]=child.sh)\n'
  script+='require_checkout() { :; }; compose_env() { export CALLER_TAINT=from_compose; }; checkout_dir() { printf "%s" "'+str(self.root)+'"; }; die() { exit 9; };\n'
  script+='cmd_run_deploy() {'+function+'\n}\ncmd_run_deploy '+service+'\n'
  if missing:self.child.unlink()
  # Startup input belongs only to the child. The fixture's parent Bash has a
  # clean environment, matching the separately qualified broker entry point.
  script='export BASH_ENV="'+str(self.startup)+'"\n'+script
  env={'PATH':'/usr/bin:/bin','HOME':str(self.root),'LANG':'C','CALLER_TAINT':'from_caller'}
  return subprocess.run(['/usr/bin/bash','--noprofile','--norc','-c',script],env=env,capture_output=True,timeout=3)
 def test_old_child_startup_hook_is_real_red_control(self):
  r=self.run_function(old=True);self.assertEqual(r.returncode,0);self.assertTrue(self.marker.exists());self.assertIn(b'TAINT=from_compose',r.stdout)
 def test_current_child_has_fixed_environment_without_startup_hook(self):
  r=self.run_function();self.assertEqual(r.returncode,0);self.assertFalse(self.marker.exists())
  for field in (b'PATH=/usr/sbin:/usr/bin:/sbin:/bin',b'HOME=/root',b'LANG=C',b'TAINT=\n'):self.assertIn(field,r.stdout)
 def test_unrelated_service_environment_is_preserved(self):
  r=self.run_function(service='other');self.assertEqual(r.returncode,0);self.assertTrue(self.marker.exists());self.assertIn(b'TAINT=from_compose',r.stdout)
 def test_missing_script_refuses_before_child(self):
  r=self.run_function(missing=True);self.assertEqual(r.returncode,9);self.assertFalse(self.marker.exists())
 def test_symlink_script_refuses_before_child(self):
  self.child.unlink();self.child.symlink_to(self.startup);r=self.run_function();self.assertEqual(r.returncode,9);self.assertFalse(self.marker.exists())
if __name__=='__main__':unittest.main()
