"""Source-only preparation. Never resolve authority, install or open a Journal."""
import hashlib
import json
from pathlib import Path
import sys

REFERENCES = (
    'authenticated_executor', 'executor_os_identity', 'owned_staging_directory',
    'original_journal_identity', 'trusted_current_head_checkpoint',
    'original_campaign_account_provider_model', 'original_caller_jwks_subject',
    'grant_issuer', 'distinct_custody_signer', 'charging_policy_proof',
    'wire_bounds_proof_issuer', 'current_revocation', 'native_hard_output_bound',
)
SOURCE = '709bc19e720cb049e71cbf8f58e9f584b74db31b'
BILLING = '3a169ddfd2efd1af6ca160247430ffab41df0c64'


def prepare(manifest, pins_bytes):
    """Validate public source metadata only; ref strings are never dereferenced."""
    def refused():
        raise ValueError('installation_manifest_refused')

    if not isinstance(manifest, dict) or set(manifest) != {
            'schema', 'enabled', 'phase', 'receiver_source', 'billing_source',
            'module_pins_sha256', 'protected_references'}:
        refused()
    if (manifest.get('schema') != 'BenchDisabledInstallationManifest/v1'
            or manifest.get('enabled') is not False
            or manifest.get('phase') != 'source_preparation_only'
            or manifest.get('receiver_source') != SOURCE
            or manifest.get('billing_source') != BILLING):
        refused()
    if manifest.get('module_pins_sha256') != hashlib.sha256(pins_bytes).hexdigest():
        refused()
    pins = json.loads(pins_bytes)
    if (not isinstance(pins, dict) or len(pins) != 15
            or any(not isinstance(k, str) or '/' in k or not k.endswith('.py')
                   or not isinstance(v, str) or len(v) != 64
                   or any(c not in '0123456789abcdef' for c in v)
                   for k, v in pins.items())):
        refused()
    refs = manifest.get('protected_references')
    if not isinstance(refs, dict) or set(refs) != set(REFERENCES):
        refused()
    # There is no authenticated native reference resolver in this preparation.
    # Even structurally populated strings cannot license installation or admit.
    unresolved = []
    for name in REFERENCES:
        value = refs[name]
        if value is None:
            unresolved.append(name)
        elif (not isinstance(value, dict) or set(value) != {'reference_id', 'receipt_sha256'}
              or not isinstance(value['reference_id'], str)
              or not value['reference_id'].startswith(('vault://', 'protected://'))
              or 'fixture' in value['reference_id'].lower()
              or not isinstance(value['receipt_sha256'], str)
              or len(value['receipt_sha256']) != 64
              or any(c not in '0123456789abcdef' for c in value['receipt_sha256'])):
            refused()
    return {'schema': 'BenchInstallationPreparation/v1', 'enabled': False,
            'readiness': 'NOT_MEASURED', 'activation': 'REFUSED',
            'reason': 'authenticated_reference_resolution_unavailable',
            'unresolved_references': unresolved,
            'original_journal_accesses': 0, 'credential_accesses': 0,
            'installed_files': [], 'provider_calls': 0}


def main():
    # Exactly two tracked public source files; no input path, env evaluation,
    # external loader, subprocess, secret output or install/activate verb.
    if len(sys.argv) != 1:
        print('{"activation":"REFUSED","reason":"preparation_only"}')
        return 2
    root = Path(__file__).resolve().parent.parent
    try:
        report = prepare(json.loads((root / 'deploy/bench-monetary-v2.disabled.json').read_bytes()),
                         (root / 'test/fixtures/billing-3a-module-pins.json').read_bytes())
    except (ValueError, OSError, TypeError, KeyError):
        print('{"activation":"REFUSED","reason":"installation_manifest_refused"}')
        return 2
    print(json.dumps(report, sort_keys=True))
    # A preparation report is not readiness or admission success.
    return 2


if __name__ == '__main__':
    sys.exit(main())
