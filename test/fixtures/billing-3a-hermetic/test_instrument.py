"""Synthetic nonproduction fixtures; no provider, secret, native CLI or campaign."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import instrument as subject


def encoded(value):
    return json.dumps(value).encode()


def request():
    return {'model': 'synthetic', 'input': [
        {'type': 'message', 'role': 'user', 'content': 'synthetic nonproduction'},
        {'type': 'additional_tools', 'tools': []}], 'tool_choice': 'auto'}


def catalog():
    return {'models': [{'slug': 'gpt-6-luna', 'tool_mode': 'code_mode_only',
                        'multi_agent_version': 'v2', 'apply_patch_tool_type': 'freeform',
                        'experimental_supported_tools': ['synthetic'],
                        'other_field': 'preserve'},
                       {'slug': 'synthetic-other', 'tool_mode': 'preserve'}]}


class ToolBoundary(unittest.TestCase):
    def test_both_empty_and_no_top_list(self):
        for top in [False, True]:
            obj = request()
            if top:
                obj['tools'] = []
            answer = subject.verify_zero_callable_tools(encoded(obj))
            self.assertTrue(answer['zero_callable_tools'])
            self.assertEqual(answer['additional_tool_blocks'], 1)
            self.assertFalse(answer['runtime_authorized'])

    def test_top_tools_refused(self):
        for tools in [None, {}, 'empty', [{'type': 'function'}]]:
            obj = request(); obj['tools'] = tools
            with self.assertRaisesRegex(subject.Refused, '^top_level_tools_not_empty$'):
                subject.verify_zero_callable_tools(encoded(obj))

    def test_every_namespace_checked(self):
        obj = request(); obj['input'].append({'type': 'additional_tools', 'tools': ['functions']})
        with self.assertRaisesRegex(subject.Refused, '^additional_tools_not_empty$'):
            subject.verify_zero_callable_tools(encoded(obj))

    def test_malformed_additional(self):
        for tools in [None, {}, '', False]:
            obj = request(); obj['input'][1]['tools'] = tools
            with self.assertRaisesRegex(subject.Refused, '^additional_tools_not_empty$'):
                subject.verify_zero_callable_tools(encoded(obj))
        obj = request(); del obj['input'][1]['tools']
        with self.assertRaisesRegex(subject.Refused, '^additional_tools_not_empty$'):
            subject.verify_zero_callable_tools(encoded(obj))

    def test_hidden_namespace_refused(self):
        obj = request(); obj['input'][0]['hidden'] = {'type': 'additional_tools', 'tools': []}
        with self.assertRaisesRegex(subject.Refused, '^misplaced_additional_tools$'):
            subject.verify_zero_callable_tools(encoded(obj))

    def test_no_prior_tool_history(self):
        for kind in ['function_call', 'function_call_output', 'tool_call', 'mcp_call',
                     'computer_call', 'web_search_call']:
            obj = request(); obj['input'].append({'type': kind})
            with self.assertRaisesRegex(subject.Refused, '^tool_history_not_allowed$'):
                subject.verify_zero_callable_tools(encoded(obj))

    def test_closed_neutral_input_allowlist(self):
        for kind in ['custom_tool_call', 'custom_tool_call_output', 'local_shell_call_output',
                     'file_search_call', 'code_interpreter_call', 'future_tool_history', None]:
            obj = request(); obj['input'].append({'type': kind})
            with self.assertRaises(subject.Refused):
                subject.verify_zero_callable_tools(encoded(obj))
        obj = request(); obj['input'].append({'role': 'user', 'content': 'synthetic'})
        with self.assertRaisesRegex(subject.Refused, '^unrecognized_input_item$'):
            subject.verify_zero_callable_tools(encoded(obj))

    def test_nested_extended_tool_history_refused(self):
        for kind in ['custom_tool_call', 'custom_tool_call_output', 'local_shell_call_output',
                     'file_search_call', 'code_interpreter_call', 'future_unknown_call']:
            obj = request(); obj['input'][0]['hidden'] = {'type': kind}
            with self.assertRaisesRegex(subject.Refused, '^tool_history_not_allowed$'):
                subject.verify_zero_callable_tools(encoded(obj))

    def test_no_tool_role(self):
        obj = request(); obj['input'][0]['role'] = 'tool'
        with self.assertRaisesRegex(subject.Refused, '^tool_history_not_allowed$'):
            subject.verify_zero_callable_tools(encoded(obj))

    def test_duplicate_keys_and_nonfinite(self):
        for raw, reason in [(b'{"input":[],"tools":[],"tools":[1]}', 'duplicate_json_key'),
                            (b'{"input":[],"x":NaN}', 'nonfinite_json')]:
            with self.assertRaisesRegex(subject.Refused, '^'+reason+'$'):
                subject.verify_zero_callable_tools(raw)

    def test_invalid_shapes(self):
        for obj in [None, [], {}, {'input': None}, {'input': [None]}]:
            with self.assertRaises(subject.Refused):
                subject.verify_zero_callable_tools(encoded(obj))
        for raw in [b'', b'\xff', b'{', b'a'*(8*1024*1024+1)]:
            with self.assertRaises(subject.Refused):
                subject.verify_zero_callable_tools(raw)

    def test_no_accounting_from_shape_or_self_assertion(self):
        obj = request(); obj.update(max_output_tokens=3000, accounting_admitted=True,
                                    runtime_authorized=True, usage={'input_tokens': 1})
        answer = subject.accounting_prerequisites(encoded(obj))
        self.assertFalse(answer['runtime_authorized'])
        self.assertFalse(answer['accounting_admitted'])
        self.assertEqual(answer['verdict'], 'PAUSED_SAFE')
        self.assertIn('verified_input_token_upper_bound', answer['gaps'])

    def test_absent_output_bound_identified(self):
        answer = subject.accounting_prerequisites(encoded(request()))
        self.assertIn('request_has_no_max_output_tokens', answer['gaps'])

    def test_cli_never_admits_and_never_prints_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'request.json'; path.write_bytes(encoded(request()))
            run = subprocess.run([sys.executable, '-I', '-B', str(Path(subject.__file__)), str(path)],
                                 capture_output=True, timeout=5)
        self.assertEqual(run.returncode, 3)
        self.assertNotIn(b'synthetic nonproduction', run.stdout)
        self.assertFalse(json.loads(run.stdout)['runtime_authorized'])


class CatalogRecipe(unittest.TestCase):
    def test_only_four_measured_edits(self):
        original = catalog(); expected = copy.deepcopy(original)
        for key in ['tool_mode', 'multi_agent_version', 'apply_patch_tool_type']:
            del expected['models'][0][key]
        expected['models'][0]['experimental_supported_tools'] = []
        actual = subject.tools_off_catalog(encoded(original))
        self.assertEqual(actual, expected)
        self.assertEqual(original, catalog())

    def test_missing_or_duplicate_model(self):
        for models in [[], [catalog()['models'][0]]*2]:
            with self.assertRaisesRegex(subject.Refused, '^catalog_model_missing_or_ambiguous$'):
                subject.tools_off_catalog(encoded({'models': models}))

    def test_unmeasured_recipe_refused(self):
        for key in ['tool_mode', 'multi_agent_version', 'apply_patch_tool_type', 'experimental_supported_tools']:
            obj = catalog(); obj['models'][0][key] = None
            with self.assertRaisesRegex(subject.Refused, '^unmeasured_catalog_recipe$'):
                subject.tools_off_catalog(encoded(obj))

    def test_malformed_catalog(self):
        for obj in [[], {}, {'models': None}, {'models': [None]}]:
            with self.assertRaises(subject.Refused):
                subject.tools_off_catalog(encoded(obj))

    def test_catalog_pins_and_exact_override_recipe(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'catalog.json'; path.write_bytes(encoded(catalog()))
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            args = subject.native_overrides(path, digest)
            self.assertEqual(args[1:], ['features.goals=false',
                'tools.experimental_request_user_input={enabled=false}', 'features.code_mode_host=false'])
            self.assertEqual(args[0], 'model_catalog_json='+json.dumps(str(path)))
            with self.assertRaisesRegex(subject.Refused, '^tools_off_catalog_drift$'):
                subject.native_overrides(path, '0'*64)
            link = Path(tmp)/'link.json'; link.symlink_to(path)
            with self.assertRaisesRegex(subject.Refused, '^catalog_path$'):
                subject.native_overrides(link, digest)


if __name__ == '__main__':
    unittest.main()
