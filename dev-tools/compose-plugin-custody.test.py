"""Bounded synthetic custody controls; not native plugin/CI qualification."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('custody',Path(__file__).resolve().parents[1]/'scripts/compose-plugin-custody.py')
subject=importlib.util.module_from_spec(spec);spec.loader.exec_module(subject)

class Controls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mc-plugin-control-',dir=Path.home())
        self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.home=self.root/'home';self.home.mkdir(mode=0o700)
        self.source=self.root/'plugin';self.source.write_bytes(b'bounded synthetic executable');self.source.chmod(0o500)
        for key,value in [('SOURCE',self.source),('SOURCE_SHA256',hashlib.sha256(self.source.read_bytes()).hexdigest()),('SOURCE_OWNER',os.getuid())]:
            p=patch.object(subject,key,value);p.start();self.addCleanup(p.stop)
    def test_positive_copy_is_exact_private_and_no_ambient_config(self):
        receipt=subject.stage(self.home);copy=self.home/'.docker/cli-plugins/docker-compose'
        self.assertEqual(copy.read_bytes(),self.source.read_bytes());self.assertEqual(copy.stat().st_mode&0o777,0o500)
        self.assertFalse(receipt['global_changes']);self.assertEqual(set(self.home.iterdir()),{self.home/'.docker'})
    def test_hash_mismatch_refuses_before_destination(self):
        self.source.chmod(0o700);self.source.write_bytes(b'drift');self.source.chmod(0o500)
        with self.assertRaisesRegex(ValueError,'hash mismatch'):subject.stage(self.home)
        self.assertFalse((self.home/'.docker').exists())
    def test_collision_preserves_foreign_contents(self):
        (self.home/'.docker').mkdir();(self.home/'.docker/foreign').write_text('historical')
        with self.assertRaises(ValueError):subject.stage(self.home)
        self.assertEqual((self.home/'.docker/foreign').read_text(),'historical')
    def test_source_symlink_refuses(self):
        target=self.root/'real';self.source.rename(target);self.source.symlink_to(target)
        with self.assertRaises(OSError):subject.stage(self.home)
        self.assertFalse((self.home/'.docker').exists())
    def test_home_symlink_refuses(self):
        link=self.root/'link';link.symlink_to(self.home)
        with self.assertRaises(ValueError):subject.stage(link)
    def test_writable_ancestor_refuses(self):
        self.root.chmod(0o777)
        with self.assertRaisesRegex(ValueError,'ancestor'):subject.stage(self.home)
    def test_changed_ancestor_refuses(self):
        before=self.root.stat();self.assertNotEqual(before.st_ino,0)
        with self.assertRaisesRegex(ValueError,'replaced'):subject.unchanged([(self.root,before.st_dev,before.st_ino+1)])
    def test_hardlinked_source_refuses(self):
        os.link(self.source,self.root/'twin')
        with self.assertRaisesRegex(ValueError,'custody'):subject.stage(self.home)

if __name__=='__main__':unittest.main()
