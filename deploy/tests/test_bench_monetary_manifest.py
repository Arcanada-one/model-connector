"""Offline source-preparation boundary controls; no live refs or ledger."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('bench_manifest', ROOT / 'deploy/bench-monetary-manifest.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PreparationControls(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / 'deploy/bench-monetary-v2.disabled.json').read_bytes())
        self.pins = (ROOT / 'test/fixtures/billing-3a-module-pins.json').read_bytes()

    def test_disabled_has_zero_external_access_and_refuses_all_missing_refs(self):
        with patch('builtins.open', side_effect=AssertionError('no access')), \
                patch.object(Path, 'read_bytes', side_effect=AssertionError('no access')):
            report = MODULE.prepare(self.manifest, self.pins)
        self.assertEqual(report['activation'], 'REFUSED')
        self.assertEqual(report['readiness'], 'NOT_MEASURED')
        self.assertEqual(set(report['unresolved_references']), set(MODULE.REFERENCES))
        self.assertEqual(report['installed_files'], [])

    def test_enabled_and_bootstrap_attempts_refuse(self):
        for value in (True, 1, 'false', None):
            self.manifest['enabled'] = value
            with self.assertRaisesRegex(ValueError, '^installation_manifest_refused$'):
                MODULE.prepare(self.manifest, self.pins)

    def test_fixture_or_wrong_reference_refuses_without_disclosing_value(self):
        for value in ('/original/journal', {'reference_id': 'protected://fixture-only',
                                          'receipt_sha256': 'a' * 64}):
            self.manifest['protected_references']['authenticated_executor'] = value
            with self.assertRaisesRegex(ValueError, '^installation_manifest_refused$'):
                MODULE.prepare(self.manifest, self.pins)

    def test_populated_reference_ids_still_do_not_authorize(self):
        for name in MODULE.REFERENCES:
            self.manifest['protected_references'][name] = {
                'reference_id': 'protected://incumbent-reference', 'receipt_sha256': 'a' * 64}
        report = MODULE.prepare(self.manifest, self.pins)
        self.assertEqual(report['unresolved_references'], [])
        self.assertEqual(report['activation'], 'REFUSED')
        self.assertEqual(report['reason'], 'authenticated_reference_resolution_unavailable')

    def test_changed_source_or_module_pin_refuses(self):
        for key in ('receiver_source', 'billing_source', 'module_pins_sha256'):
            altered = copy.deepcopy(self.manifest)
            altered[key] = '0' * 64
            with self.assertRaisesRegex(ValueError, '^installation_manifest_refused$'):
                MODULE.prepare(altered, self.pins)
        with self.assertRaisesRegex(ValueError, '^installation_manifest_refused$'):
            MODULE.prepare(self.manifest, self.pins + b' ')

    def test_unknown_or_missing_reference_name_refuses(self):
        self.manifest['protected_references'].pop('current_revocation')
        with self.assertRaisesRegex(ValueError, '^installation_manifest_refused$'):
            MODULE.prepare(self.manifest, self.pins)

    def test_unrecognized_bootstrap_or_installer_fields_refuse(self):
        self.manifest['bootstrap'] = '/original/journal'
        with self.assertRaisesRegex(ValueError, '^installation_manifest_refused$'):
            MODULE.prepare(self.manifest, self.pins)


if __name__ == '__main__':
    unittest.main()
