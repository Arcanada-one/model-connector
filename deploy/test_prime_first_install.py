import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('prime',HERE/'prime-first-install.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
SHA='b'*40
IMAGE='ghcr.io/arcanada-one/vocatlas-factory@sha256:'+'a'*64
CID='c'*64
IID='sha256:'+'d'*64

class Native:
    def __init__(self): self.ids=[];self.row=[];self.calls=[];self.fail_stop=False;self.port_busy=False
    def call(self,argv,env=None):
        self.calls.append(argv)
        if 'rev-parse' in argv:return SHA
        if 'get-url' in argv:return 'https://github.com/Arcanada-one/vocatlas-factory.git'
        if 'merge-base' in argv or 'status' in argv:return ''
        if 'ls-files' in argv:return 'H deploy/compose.prime.yml'
        if 'image' in argv:return SHA if 'revision' in argv[-2] else IID
        if 'config' in argv:return '{}'
        if 'stop' in argv:
            if self.fail_stop:raise p.Refusal('unknown')
            return CID
        if 'rm' in argv:self.ids=[];return CID
        raise AssertionError(argv)
    def project(self):return self.ids[:]
    def identity(self,ident):return self.row[:]
    def port_free(self,port):
        if self.port_busy:raise p.Refusal('port')

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='prime-owned-test-',dir=Path.home());self.root=Path(self.tmp.name)
        self.root.chmod(0o700);(self.root/'prime/deploy').mkdir(parents=True)
        self.compose=self.root/'prime/deploy/compose.prime.yml';self.compose.write_text('owned source')
        self.release=self.root/'release.json';self.data={'schema':'PrimeFirstInstall/v1','source_sha':SHA,'image':IMAGE,'port':18993,'compose_sha256':hashlib.sha256(self.compose.read_bytes()).hexdigest()}
        self.write_release();self.native=Native();self.e=p.Engine(self.root,self.release,self.native,os.getuid(),lambda *args:None)
    def tearDown(self):self.tmp.cleanup()
    def write_release(self):self.release.write_text(json.dumps(self.data));self.release.chmod(0o600)
    def bound(self):
        attempt=self.e.arm(SHA);self.native.ids=[CID]
        self.native.row=[CID,IID,'prime','health',attempt,','.join([str(self.compose),str(self.e.private/'attempt.json')])]
        self.e.bind(attempt);return attempt
    def test_owned_first_rollback(self):
        attempt=self.bound();self.e.rollback(attempt)
        effects=[v for v in self.native.calls if 'stop' in v or 'rm' in v]
        self.assertEqual(effects,[['/usr/bin/docker','stop','--time','10',CID],['/usr/bin/docker','rm',CID]])
        self.assertEqual(json.loads((self.e.private/'receipt.json').read_text())['phase'],'ROLLED_BACK')
        self.assertEqual(self.native.ids,[])
    def test_repeated_arm_and_bind_refuse(self):
        attempt=self.bound()
        with self.assertRaises(p.Refusal):self.e.arm(SHA)
        with self.assertRaises(p.Refusal):self.e.bind(attempt)
    def test_foreign_identity_refused_before_effect(self):
        for field,value in [(0,'e'*64),(1,'sha256:'+'e'*64),(2,'foreign'),(3,'db'),(4,'f'*32),(5,'/foreign/compose.yml')]:
            with self.subTest(field=field):
                # Each subcase receives its own frozen bound identity.
                old=self.native.row[:]
                if not old:attempt=self.bound();old=self.native.row[:]
                else:attempt=json.loads((self.e.private/'receipt.json').read_text())['attempt']
                self.native.row[field]=value;before=len(self.native.calls)
                with self.assertRaises(p.Refusal):self.e.rollback(attempt)
                self.assertFalse(any('stop' in a or 'rm' in a for a in self.native.calls[before:]));self.native.row=old
    def test_partial_stop_never_removes(self):
        attempt=self.bound();self.native.fail_stop=True
        with self.assertRaises(p.Refusal):self.e.rollback(attempt)
        self.assertFalse(any('rm' in a for a in self.native.calls))
        self.assertEqual(json.loads((self.e.private/'receipt.json').read_text())['phase'],'STOPPING')
    def test_unbound_and_foreign_project_refuse(self):
        attempt=self.e.arm(SHA)
        with self.assertRaises(p.Refusal):self.e.rollback(attempt)
        self.native.ids=[CID,'e'*64]
        with self.assertRaises(p.Refusal):self.e.bind(attempt)
    def test_missing_invalid_source_contract(self):
        self.data['image']='x:latest';self.write_release()
        with self.assertRaises(p.Refusal):self.e.arm(SHA)
        self.assertFalse(any('stop' in a or 'rm' in a for a in self.native.calls))
    def test_busy_port_and_changed_release_refuse(self):
        self.native.port_busy=True
        with self.assertRaises(p.Refusal):self.e.arm(SHA)
        self.native.port_busy=False;attempt=self.bound();self.data['port']=18994;self.write_release()
        with self.assertRaises(p.Refusal):self.e.rollback(attempt)
    def test_changed_override_and_source_refuse(self):
        attempt=self.bound();(self.e.private/'attempt.json').write_text('{}')
        with self.assertRaises(p.Refusal):self.e.rollback(attempt)
    def test_symlink_contract_refuse(self):
        self.release.unlink();self.release.symlink_to(self.compose)
        with self.assertRaises(p.Refusal):self.e.arm(SHA)

if __name__=='__main__':unittest.main()
