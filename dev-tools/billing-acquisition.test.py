"""Offline lease lifecycle controls; no registered provider, private bytes or child."""
from pathlib import Path
import importlib.util
import json
import unittest
import tempfile
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('acquisition_subject', ROOT / 'scripts/graph_full_suite.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)
HEAD = 'a' * 40


class SyntheticLease(subject.BillingFixtureLease):
    # Synthetic receiving only; no UID/job/mount authority is claimed.
    def __init__(self):
        self.check = Mock(return_value=Path('/synthetic/private/input.json'))
        self.close = Mock(return_value=subject.BillingCleanupStatus.VERIFIED)

    def revalidate(self, root, head, consumer_uid):
        return self.check(root, head, consumer_uid)

    def release(self):
        return self.close()


class Controls(unittest.TestCase):
    def run_case(self, lease, action):
        with patch.object(subject, 'require_billing_acquisition', return_value=lease):
            return subject.run_with_billing_acquisition(ROOT, HEAD, action)

    def test_real_maintained_callsite_consumes_manifest_and_releases(self):
        lease = SyntheticLease()
        with tempfile.TemporaryDirectory() as private, \
             patch.dict(subject.os.environ, {'TMPDIR': private}), \
             patch.object(subject.sys, 'argv', ['runner', '.', subject.BILLING_ACQUISITION_REQUIRED]), \
             patch.object(subject, 'check_context'), \
             patch.object(subject.subprocess, 'run', return_value=Mock(stdout=HEAD.encode())), \
             patch.object(subject, 'inventory', return_value=[]), \
             patch.object(subject, 'members_for', return_value=[]), \
             patch.object(subject, 'plan', return_value=[]), \
             patch.object(subject, 'run_root_suites', return_value=[]) as dispatch, \
             patch.object(subject, 'require_billing_acquisition', return_value=lease):
            subject.main()
        self.assertEqual(dispatch.call_args.kwargs['billing_fixture_manifest'],
                         Path('/synthetic/private/input.json'))
        lease.close.assert_called_once_with()

    def test_actual_default_missing_adapter_has_zero_action_calls(self):
        action = Mock()
        with self.assertRaises(subject.AcquisitionUnavailable):
            subject.run_with_billing_acquisition(ROOT, HEAD, action)
        action.assert_not_called()

    def test_manifest_or_ready_metadata_is_not_lease(self):
        for value in [None, Path('/private/input'), {'ready': True}, Mock()]:
            action = Mock()
            with self.subTest(value=type(value)), self.assertRaises(subject.AcquisitionUnavailable):
                self.run_case(value, action)
            action.assert_not_called()

    def test_positive_lifecycle_checks_current_root_head_uid_and_releases_once(self):
        lease = SyntheticLease()
        def action(manifest, execute):
            self.assertEqual(manifest, Path('/synthetic/private/input.json'))
            return execute('synthetic')
        with patch.object(subject, 'execute', return_value={'exit_code': 0}) as child:
            self.assertEqual(self.run_case(lease, action), {'exit_code': 0})
        child.assert_called_once_with('synthetic')
        self.assertEqual(lease.check.call_count, 3)
        for call in lease.check.call_args_list:
            self.assertEqual(call.args, (ROOT, HEAD, subject.os.geteuid()))
        lease.close.assert_called_once_with()

    def test_initial_authority_loss_dispatches_nothing_and_releases(self):
        lease = SyntheticLease(); lease.check.side_effect = subject.Refusal('private excerpt')
        action = Mock()
        with self.assertRaises(subject.AcquisitionFailure): self.run_case(lease, action)
        action.assert_not_called(); lease.close.assert_called_once_with()

    def test_invalid_manifest_is_not_dispatched(self):
        for value in [None, '/private/string', Path('relative'), Path('/private/../input')]:
            lease = SyntheticLease(); lease.check.return_value = value
            action = Mock()
            with self.subTest(value=value), self.assertRaises(subject.AcquisitionFailure):
                self.run_case(lease, action)
            action.assert_not_called(); lease.close.assert_called_once_with()

    def test_per_child_precheck_loss_has_zero_child_calls(self):
        lease = SyntheticLease()
        lease.check.side_effect = [Path('/synthetic/private/input.json'), subject.Refusal('private')]
        with patch.object(subject, 'execute') as child, self.assertRaises(subject.AcquisitionFailure):
            self.run_case(lease, lambda manifest, execute: execute('synthetic'))
        child.assert_not_called(); lease.close.assert_called_once_with()

    def test_changed_manifest_refuses_before_child(self):
        lease = SyntheticLease()
        lease.check.side_effect = [Path('/synthetic/private/input.json'), Path('/synthetic/other')]
        with patch.object(subject, 'execute') as child, self.assertRaises(subject.AcquisitionFailure):
            self.run_case(lease, lambda manifest, execute: execute('synthetic'))
        child.assert_not_called(); lease.close.assert_called_once_with()

    def test_success_then_postcheck_loss_refuses(self):
        lease = SyntheticLease()
        lease.check.side_effect = [Path('/synthetic/private/input.json')]*2 + [subject.Refusal('private')]
        with patch.object(subject, 'execute', return_value={'exit_code': 0}), \
             self.assertRaises(subject.AcquisitionFailure) as error:
            self.run_case(lease, lambda manifest, execute: execute('synthetic'))
        self.assertEqual(error.exception.failure_facts['execution']['status'], 0)
        self.assertEqual(error.exception.failure_facts['acquisition']['phase'], 'post_dispatch')
        lease.close.assert_called_once_with()

    def test_child_and_postcheck_failure_keep_both_safe_facts(self):
        lease = SyntheticLease()
        lease.check.side_effect = [Path('/synthetic/private/input.json')]*2 + [subject.Refusal('private lease')]
        with patch.object(subject, 'execute', side_effect=TimeoutError('private child')), \
             self.assertRaises(subject.AcquisitionFailure) as error:
            self.run_case(lease, lambda manifest, execute: execute('synthetic'))
        self.assertEqual(error.exception.failure_facts['execution']['class'], 'TimeoutError')
        self.assertEqual(error.exception.failure_facts['acquisition']['phase'], 'post_dispatch')
        self.assertNotIn('private', json.dumps(error.exception.failure_facts))
        lease.close.assert_called_once_with()

    def test_nested_source_custody_keeps_child_and_lease_failure_facts(self):
        import types
        lease = SyntheticLease()
        lease.check.side_effect = [Path('/synthetic/private/input.json')]*2 + [subject.Refusal('private lease')]
        error_type = type('InputRefused', (Exception,), {})
        custody = Mock(); custody.revalidate.side_effect = [None, error_type('private custody')]
        receiver = types.SimpleNamespace(SourceCustody=Mock(return_value=custody), InputRefused=error_type)
        loader = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module: None))
        def action(manifest, execute):
            return subject.run_root_suites(ROOT, [], ROOT, execute, billing_fixture_manifest=manifest)
        def body(root, suites, scratch, execute, **kwargs): return execute('synthetic')
        with patch.object(subject.importlib.util, 'spec_from_file_location', return_value=loader), \
             patch.object(subject.importlib.util, 'module_from_spec', return_value=receiver), \
             patch.object(subject, '_run_root_suites', side_effect=body), \
             patch.object(subject, 'execute', side_effect=TimeoutError('private child')), \
             self.assertRaises(subject.DispatchFailure) as error:
            self.run_case(lease, action)
        facts = error.exception.failure_facts
        self.assertEqual(facts['child']['execution']['class'], 'TimeoutError')
        self.assertEqual(facts['child']['acquisition']['phase'], 'post_dispatch')
        self.assertEqual(facts['custody']['status'], 'refused')
        self.assertNotIn('private', json.dumps(facts))
        custody.release.assert_called_once_with(); lease.close.assert_called_once_with()

    def test_actual_source_fd_cleanup_keeps_prior_facts_and_drains(self):
        import types, os
        spec = importlib.util.spec_from_file_location('real_receiver', ROOT / 'scripts/billing_fixture_input.py')
        real = importlib.util.module_from_spec(spec); spec.loader.exec_module(real)
        custody = real.SourceCustody.__new__(real.SourceCustody)
        alive, dead = os.open('/dev/null', os.O_RDONLY), os.open('/dev/null', os.O_RDONLY)
        custody.entries = [(Path('/synthetic/alive'), alive, custody._stamp(os.fstat(alive))),
                           (Path('/synthetic/dead'), dead, custody._stamp(os.fstat(dead)))]
        custody.closed = False
        os.close(dead)
        custody.revalidate = Mock(side_effect=[None, real.InputRefused('private custody')])
        receiver = types.SimpleNamespace(SourceCustody=Mock(return_value=custody),
            InputRefused=real.InputRefused, CleanupRefused=real.CleanupRefused)
        loader = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module: None))
        lease = SyntheticLease()
        lease.check.side_effect = [Path('/synthetic/private/input.json')]*2 + [subject.Refusal('private lease')]
        def action(manifest, execute):
            return subject.run_root_suites(ROOT, [], ROOT, execute, billing_fixture_manifest=manifest)
        def body(root, suites, scratch, execute, **kwargs): return execute('synthetic')
        try:
            with patch.object(subject.importlib.util, 'spec_from_file_location', return_value=loader), \
                 patch.object(subject.importlib.util, 'module_from_spec', return_value=receiver), \
                 patch.object(subject, '_run_root_suites', side_effect=body), \
                 patch.object(subject, 'execute', side_effect=TimeoutError('private child')), \
                 self.assertRaises(subject.SourceCleanupFailure) as error:
                self.run_case(lease, action)
            facts = error.exception.failure_facts
            self.assertEqual(facts['execution']['child']['execution']['class'], 'TimeoutError')
            self.assertEqual(facts['execution']['child']['acquisition']['phase'], 'post_dispatch')
            self.assertEqual(facts['execution']['custody']['status'], 'refused')
            self.assertEqual(facts['source_cleanup'], [{'status': 'unknown', 'reason': 'descriptor_missing'}])
            self.assertNotIn('private', json.dumps(facts))
            with self.assertRaises(OSError): os.fstat(alive)
            lease.close.assert_called_once_with()
            custody.release()
        finally:
            try: os.fstat(alive)
            except OSError: pass
            else: os.close(alive)

    def test_child_and_release_failure_keep_both_safe_facts(self):
        lease = SyntheticLease(); lease.close.side_effect = OSError('private cleanup')
        with patch.object(subject, 'execute', side_effect=ValueError('private child')), \
             self.assertRaises(subject.AcquisitionFailure) as error:
            self.run_case(lease, lambda manifest, execute: execute('synthetic'))
        facts = error.exception.failure_facts
        self.assertEqual(facts['execution']['execution']['class'], 'ValueError')
        self.assertEqual(facts['acquisition']['phase'], 'release')
        self.assertNotIn('private', json.dumps(facts))
        lease.close.assert_called_once_with()

    def test_action_error_releases_once_without_private_exception_text(self):
        lease = SyntheticLease()
        with self.assertRaises(subject.AcquisitionFailure) as error:
            self.run_case(lease, Mock(side_effect=ValueError('private planning')))
        self.assertEqual(error.exception.failure_facts['execution']['class'], 'ValueError')
        self.assertNotIn('private', str(error.exception))
        lease.close.assert_called_once_with()

    def test_unknown_cleanup_or_ready_fields_refuse_success(self):
        for value in [None, subject.BillingCleanupStatus.UNKNOWN, True, {'status': 'verified'}]:
            lease = SyntheticLease(); lease.close.return_value = value
            with self.subTest(value=value), self.assertRaises(subject.AcquisitionFailure):
                self.run_case(lease, Mock(return_value={'exit_code': 0}))
            lease.close.assert_called_once_with()

    def test_release_failure_refuses_success_and_is_not_retried(self):
        lease = SyntheticLease(); lease.close.side_effect = OSError('private cleanup')
        with self.assertRaises(subject.AcquisitionFailure) as error:
            self.run_case(lease, Mock(return_value={'exit_code': 0}))
        self.assertEqual(error.exception.failure_facts['acquisition']['phase'], 'release')
        lease.close.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
