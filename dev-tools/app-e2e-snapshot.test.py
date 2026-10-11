"""Synthetic immutable-source and dependency boundary controls; no Docker."""
import importlib.util, subprocess, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('snapshot',Path(__file__).resolve().parents[1]/'scripts/app-e2e-snapshot.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Controls(unittest.TestCase):
    def fixture(self, root):
        (root/'pnpm-lock.yaml').write_text('synthetic lock')
        (root/'app.ts').write_text('original')
        for args in [('init','-q'),('add','.'),('-c','user.name=Arcanada','-c','user.email=dev@veritasarcana.ai','commit','-qm','fixture')]:
            subprocess.run(['git',*args],cwd=root,check=True,capture_output=True)
        (root/'node_modules').mkdir();(root/'node_modules/dependency').write_text('owned')
        return subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip()
    def test_mutation_and_ignored_poison_do_not_enter_export(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); head=self.fixture(root);(root/'app.ts').write_text('mutated');(root/'ignored.env').write_text('poison')
            owned=root/'owned';owned.mkdir();m.export(root,head,owned)
            self.assertEqual((owned/'source/app.ts').read_text(),'original')
            self.assertFalse((owned/'source/ignored.env').exists())
    def test_dependency_symlink_escape_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);head=self.fixture(root);(root/'node_modules/escape').symlink_to(root/'app.ts')
            owned=root/'owned';owned.mkdir()
            with self.assertRaisesRegex(ValueError,'escapes'):m.export(root,head,owned)
    def test_wrong_head_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);self.fixture(root);owned=root/'owned';owned.mkdir()
            with self.assertRaises(ValueError):m.export(root,'HEAD',owned)
if __name__=='__main__':unittest.main()
