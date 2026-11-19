#!/usr/bin/env python3
"""Offline custody of the measured native tools-off recipe; never sends a request.

reuse: approved r2_selectionfix make_tools_off_catalog.tools_off and
helper.NATIVE_EXTRA_OVERRIDES; strict request checks cover both native tool lists.
"""
import argparse
import hashlib
import json
from pathlib import Path


class Refused(ValueError):
    """A named refusal without request, credential or prompt contents."""


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def strict_json(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 8 * 1024 * 1024,
            'request_size_or_type')

    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'duplicate_json_key')
            value[key] = item
        return value

    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(
                              Refused('nonfinite_json')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise Refused('invalid_json') from error


def tools_off_catalog(raw):
    """Apply only the four measured edits to exactly one gpt-6-luna entry."""
    catalog = strict_json(raw)
    require(isinstance(catalog, dict) and isinstance(catalog.get('models'), list),
            'catalog_shape')
    require(all(isinstance(model, dict) for model in catalog['models']),
            'catalog_model_shape')
    models = [m for m in catalog['models'] if m.get('slug') == 'gpt-6-luna']
    require(len(models) == 1, 'catalog_model_missing_or_ambiguous')
    model = models[0]
    require(model.get('tool_mode') == 'code_mode_only' and
            model.get('multi_agent_version') == 'v2' and
            model.get('apply_patch_tool_type') == 'freeform' and
            isinstance(model.get('experimental_supported_tools'), list),
            'unmeasured_catalog_recipe')
    for key in ('tool_mode', 'multi_agent_version', 'apply_patch_tool_type'):
        del model[key]
    model['experimental_supported_tools'] = []
    return catalog


def native_overrides(catalog_path, catalog_sha256):
    """Return measured overrides only; caller owns actual native execution."""
    path = Path(catalog_path)
    require(path.is_absolute() and not path.is_symlink() and path.is_file(),
            'catalog_path')
    require(hashlib.sha256(path.read_bytes()).hexdigest() == catalog_sha256,
            'tools_off_catalog_drift')
    return [
        'model_catalog_json=' + json.dumps(str(path)),
        'features.goals=false',
        'tools.experimental_request_user_input={enabled=false}',
        'features.code_mode_host=false',
    ]


def verify_zero_callable_tools(raw):
    """Fail closed on both lists, malformed namespaces and prior tool execution."""
    request = strict_json(raw)
    require(isinstance(request, dict) and isinstance(request.get('input'), list),
            'request_shape')
    require('tools' not in request or request['tools'] == [],
            'top_level_tools_not_empty')
    additional = 0
    forbidden = {'function_call', 'function_call_output', 'tool_call',
                 'mcp_call', 'computer_call', 'web_search_call'}

    def inspect(value, direct_input=False):
        nonlocal additional
        if isinstance(value, dict):
            kind = value.get('type')
            require(not isinstance(kind, str) or (kind not in forbidden and
                    not kind.endswith(('_call', '_call_output'))),
                    'tool_history_not_allowed')
            require(value.get('role') != 'tool', 'tool_history_not_allowed')
            if kind == 'additional_tools':
                require(direct_input, 'misplaced_additional_tools')
                require('tools' in value and value['tools'] == [],
                        'additional_tools_not_empty')
                additional += 1
            for child in value.values():
                inspect(child)
        elif isinstance(value, list):
            for child in value:
                inspect(child)

    for key, value in request.items():
        if key != 'input':
            inspect(value)
    for item in request['input']:
        require(isinstance(item, dict), 'input_item_shape')
        inspect(item, direct_input=True)
        require(item.get('type') in ('message', 'additional_tools'),
                'unrecognized_input_item')
    # A tools-off composition says nothing about authentication, retries or caps.
    return {'schema': 'OfflineNativeRequestShape/v1',
            'zero_callable_tools': True, 'additional_tool_blocks': additional,
            'request_sha256': hashlib.sha256(raw).hexdigest(),
            'max_output_tokens_present': 'max_output_tokens' in request,
            'runtime_authorized': False, 'accounting_admitted': False,
            'model_calls': 0}


def accounting_prerequisites(raw):
    """Diagnostic gaps, never an invented signed lease or provider budget gate."""
    shape = verify_zero_callable_tools(raw)
    gaps = ['actual_upstream_attempt_observer_and_durable_reservation',
            'verified_input_token_upper_bound',
            'provider_enforced_output_bound',
            'unknown_usage_and_retry_reconciliation',
            'deny_direct_egress_and_transport_bypass',
            'independent_native_route_admission']
    if not shape['max_output_tokens_present']:
        gaps.insert(0, 'request_has_no_max_output_tokens')
    return dict(shape, verdict='PAUSED_SAFE', gaps=gaps)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    args = parser.parse_args()
    try:
        result = accounting_prerequisites(args.request.read_bytes())
    except (Refused, OSError) as error:
        reason = str(error) if isinstance(error, Refused) else 'request_io_refused'
        print(json.dumps({'verdict': 'REFUSED', 'reason': reason,
                          'runtime_authorized': False, 'model_calls': 0}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 3  # Shape pass alone is never execution admission.


if __name__ == '__main__':
    raise SystemExit(main())
