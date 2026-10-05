"""Offline packaging controls. No installed image or native authority is inferred."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('package', ROOT / 'bench-receiving-package.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
SHA = 'a' * 40


class PackagingContracts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in p.FILES:
            shutil.copyfile(ROOT / name, self.root / name)

    def test_exact_disabled_source_import_and_provenance(self):
        p.seal(self.root, SHA)
        result = p.verify(self.root, SHA, SHA)
        self.assertFalse(result['enabled'])
        self.assertFalse(result['runtime_authorized'])
        self.assertEqual(result['journal_calls'], 0)
        self.assertEqual(result['provider_calls'], 0)
        self.assertEqual(result['native_resolver'], 'NOT_MEASURED')
        manifest = json.loads((self.root / p.FILES[1]).read_text())
        self.assertEqual(len(manifest['protected_references']), 13)
        self.assertTrue(all(v is None for v in manifest['protected_references'].values()))

    def test_missing_or_wrong_build_revision_refuses(self):
        for revision in (None, '', 'HEAD', 'a' * 39, 'a' * 41):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                p.seal(self.root, revision)
        p.seal(self.root, SHA)
        with self.assertRaises(ValueError):
            p.verify(self.root, SHA, 'b' * 40)

    def test_missing_receipt_and_missing_receiver_refuse(self):
        with self.assertRaises(ValueError):
            p.verify(self.root, SHA, SHA)
        p.seal(self.root, SHA)
        (self.root / p.FILES[0]).unlink()
        with self.assertRaises(ValueError):
            p.verify(self.root, SHA, SHA)

    def test_receiver_or_provenance_drift_refuses(self):
        p.seal(self.root, SHA)
        original = (self.root / p.FILES[0]).read_bytes()
        (self.root / p.FILES[0]).write_bytes(original + b'\n# drift\n')
        with self.assertRaises(ValueError):
            p.verify(self.root, SHA, SHA)
        (self.root / p.FILES[0]).write_bytes(original)
        receipt = self.root / p.RECEIPT
        data = json.loads(receipt.read_text())
        data['build_source'] = 'b' * 40
        receipt.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            p.verify(self.root, SHA, SHA)

    def test_manifest_activation_or_reference_changes_refuse(self):
        path = self.root / p.FILES[1]
        original = json.loads(path.read_text())
        for mutation in ('enabled', 'reference'):
            data = json.loads(json.dumps(original))
            if mutation == 'enabled':
                data['enabled'] = True
            else:
                data['protected_references']['grant_issuer'] = 'sentinel-never-authority'
            path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                p.seal(self.root, SHA)

    def test_symlink_and_overwrite_refuse(self):
        path = self.root / p.FILES[0]
        path.unlink()
        path.symlink_to(ROOT / p.FILES[0])
        with self.assertRaises(ValueError):
            p.seal(self.root, SHA)
        path.unlink()
        shutil.copyfile(ROOT / p.FILES[0], path)
        p.seal(self.root, SHA)
        before = (self.root / p.RECEIPT).read_bytes()
        with self.assertRaises(FileExistsError):
            p.seal(self.root, SHA)
        self.assertEqual((self.root / p.RECEIPT).read_bytes(), before)

    def test_image_and_ci_allowlisted_offline_route(self):
        repo = ROOT.parent
        docker = (repo / 'Dockerfile').read_text()
        production = docker.split('FROM base AS production', 1)[1]
        self.assertIn('python3-minimal', production)
        self.assertIn('COPY deploy/bench-account-receiving.py deploy/bench-monetary-v2.disabled.json deploy/bench-receiving-package.py /app/deploy/', production)
        self.assertNotIn('COPY deploy/ /app/deploy', production)
        self.assertIn('chmod 0555 /app/deploy && chmod 0444 /app/deploy/*', production)
        workflow = (repo / '.github/workflows/ci.yml').read_text()
        self.assertIn('--build-arg MC_BUILD_SHA="$GITHUB_SHA"', workflow)
        self.assertIn('--network=none --read-only --entrypoint python3', workflow)
        self.assertIn('/app/deploy/bench-receiving-package.py verify "$GITHUB_SHA"', workflow)


if __name__ == '__main__':
    unittest.main()
