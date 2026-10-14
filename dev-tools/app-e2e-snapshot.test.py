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
    def test_generated_mountpoint_is_empty_recorded_and_drift_bound(self):
        import json, hashlib
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);head=self.fixture(root);owned=root/'owned';owned.mkdir();m.export(root,head,owned)
            mount=owned/'source/node_modules'
            self.assertTrue(mount.is_dir());self.assertEqual(list(mount.iterdir()),[])
            record=json.loads((owned/'custody.json').read_text())
            self.assertEqual(record['generated_support'][0]['path'],'node_modules')
            digest=hashlib.sha256((owned/'custody.json').read_bytes()).hexdigest()
            m.verify(owned,digest)
            (mount/'poison').write_text('unrecorded')
            with self.assertRaisesRegex(ValueError,'source changed'):m.verify(owned,digest)
    def test_tracked_mountpoint_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);self.fixture(root)
            subprocess.run(['git','add','node_modules'],cwd=root,check=True,capture_output=True)
            subprocess.run(['git','-c','user.name=Arcanada','-c','user.email=dev@veritasarcana.ai','commit','-qm','occupied'],cwd=root,check=True,capture_output=True)
            head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip()
            owned=root/'owned';owned.mkdir()
            with self.assertRaisesRegex(ValueError,'occupies generated'):m.export(root,head,owned)
    def test_dependency_symlink_escape_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);head=self.fixture(root);(root/'node_modules/escape').symlink_to(root/'app.ts')
            owned=root/'owned';owned.mkdir()
            with self.assertRaisesRegex(ValueError,'escapes'):m.export(root,head,owned)
    def test_wrong_head_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);self.fixture(root);owned=root/'owned';owned.mkdir()
            with self.assertRaises(ValueError):m.export(root,'HEAD',owned)
    def workspace_fixture(self, root):
        self.fixture(root)
        (root/'pnpm-workspace.yaml').write_text('packages:\n  - "packages/*"\n  - "watcher"\n')
        for relative, name in [('packages/sdk-ts','@arcanada/model-connector-sdk'),('watcher','@arcanada/model-connector-watcher')]:
            folder=root/relative;folder.mkdir(parents=True)
            (folder/'package.json').write_text(__import__('json').dumps({'name':name}))
            (folder/'source.ts').write_text('committed workspace')
        subprocess.run(['git','add','pnpm-workspace.yaml','packages','watcher'],cwd=root,check=True,capture_output=True)
        subprocess.run(['git','-c','user.name=Arcanada','-c','user.email=dev@veritasarcana.ai','commit','-qm','workspace'],cwd=root,check=True,capture_output=True)
        links=root/'node_modules/.pnpm/node_modules/@arcanada';links.mkdir(parents=True)
        (links/'model-connector-sdk').symlink_to('../../../../packages/sdk-ts')
        (links/'model-connector-watcher').symlink_to('../../../../watcher')
        return subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip()
    def test_git_bound_workspace_targets_are_private_and_oid_bound(self):
        import json
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);head=self.workspace_fixture(root)
            (root/'packages/sdk-ts/source.ts').write_text('late mutation')
            (root/'watcher/ignored-secret').write_text('ignored poison')
            owned=root/'owned';owned.mkdir();m.export(root,head,owned)
            link=owned/'dependencies/node_modules/.pnpm/node_modules/@arcanada/model-connector-sdk'
            self.assertTrue(link.resolve().is_relative_to(owned))
            self.assertEqual((link/'source.ts').read_text(),'committed workspace')
            self.assertFalse((owned/'dependencies/watcher/ignored-secret').exists())
            bindings=json.loads((owned/'custody.json').read_text())['workspace_bindings']
            self.assertEqual(len(bindings),2)
            for row in bindings:
                self.assertEqual(row['tree_oid'],subprocess.check_output(['git','rev-parse',head+':'+row['path']],cwd=root).decode().strip())
    def test_workspace_package_name_mismatch_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);head=self.workspace_fixture(root)
            link=root/'node_modules/.pnpm/node_modules/@arcanada/model-connector-sdk';link.unlink()
            (link.parent/'other-name').symlink_to('../../../../packages/sdk-ts')
            owned=root/'owned';owned.mkdir()
            with self.assertRaisesRegex(ValueError,'escapes'):m.export(root,head,owned)
    def test_workspace_parent_symlink_outside_refuses(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as outside:
            root=Path(d);head=self.workspace_fixture(root)
            import shutil
            shutil.move(str(root/'packages'),str(Path(outside)/'packages'))
            (root/'packages').symlink_to(Path(outside)/'packages')
            owned=root/'owned';owned.mkdir()
            with self.assertRaisesRegex(ValueError,'escapes'):m.export(root,head,owned)
    def test_private_source_dependency_and_workspace_drift_refuse(self):
        import hashlib
        for target in ('source/app.ts','dependencies/node_modules/dependency','dependencies/packages/sdk-ts/source.ts','custody.json'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as d:
                root=Path(d);head=self.workspace_fixture(root);owned=root/'owned';owned.mkdir();m.export(root,head,owned)
                digest=hashlib.sha256((owned/'custody.json').read_bytes()).hexdigest()
                m.verify(owned,digest)
                with (owned/target).open('a') as stream:stream.write('mutation')
                with self.assertRaises(ValueError):m.verify(owned,digest)
    def test_dependency_capacity_refuses_without_large_allocation(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);self.fixture(root);old=m.MAX_BYTES
            try:
                m.MAX_BYTES=1
                with self.assertRaisesRegex(ValueError,'capacity'):m.inventory(root/'node_modules')
            finally:m.MAX_BYTES=old
    def test_workspace_mode_drift_refuses(self):
        import hashlib
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);head=self.workspace_fixture(root);owned=root/'owned';owned.mkdir();m.export(root,head,owned)
            digest=hashlib.sha256((owned/'custody.json').read_bytes()).hexdigest()
            (owned/'dependencies/packages/sdk-ts/source.ts').chmod(0o700)
            with self.assertRaisesRegex(ValueError,'workspace'):m.verify(owned,digest)
    def test_git_tree_cannot_masquerade_as_subject_commit(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);head=self.fixture(root);owned=root/'owned';owned.mkdir()
            tree=subprocess.check_output(['git','rev-parse',head+'^{tree}'],cwd=root).decode().strip()
            with self.assertRaisesRegex(ValueError,'nonexact'):m.export(root,tree,owned)
if __name__=='__main__':unittest.main()
