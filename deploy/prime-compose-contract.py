#!/usr/bin/env python3
"""C07 configuration-only check; never grants deployment/runtime authority."""
import argparse
import json
import re
import sys

LIMIT = 65536
IMAGE = re.compile(r"ghcr\.io/arcanada-one/vocatlas-factory@sha256:[0-9a-f]{64}")


class Refusal(ValueError):
    pass


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise Refusal("duplicate_key")
        result[key] = value
    return result


def check(config, image, port):
    if not isinstance(image, str) or not IMAGE.fullmatch(image):
        raise Refusal("immutable_image_required")
    if type(port) is not int or not 1024 <= port <= 65535:
        raise Refusal("unprivileged_port_required")
    expected = {
        "name": "prime",
        "networks": {"health": {"name": "prime_health", "ipam": {}, "internal": True}},
        "services": {"health": {
            "cap_drop": ["ALL"], "cpus": 0.25,
            "command": None, "entrypoint": None,
            "environment": {"PRIME_BIND_HOST": "0.0.0.0"},
            "healthcheck": {
                "test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"],
                "timeout": "5s", "interval": "30s", "retries": 3, "start_period": "5s"},
            "image": image, "init": True,
            "labels": {"org.arcanada.authority": "process-health-only", "org.arcanada.service": "prime-agent"},
            "mem_limit": "134217728", "networks": {"health": None}, "pids_limit": 32,
            "ports": [{"mode": "ingress", "host_ip": "127.0.0.1", "target": 8080,
                       "published": str(port), "protocol": "tcp"}],
            "read_only": True, "restart": "unless-stopped",
            "security_opt": ["no-new-privileges:true"],
            "tmpfs": ["/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777"],
            "user": "1000:1000"}},
    }
    # Serialized comparison preserves types (True is not the integer 1).
    if json.dumps(config, sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise Refusal("rendered_contract_differs")


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse otherwise repeats arbitrary caller values in stderr.
        print('{"verdict":"REFUSE","scope":"configuration_only","runtime_authorized":false}')
        raise SystemExit(1)


def main():
    parser = SafeParser(description=__doc__)
    parser.add_argument("--expected-image", required=True)
    parser.add_argument("--expected-port", type=int, required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise Refusal("capture_limit")
        config = json.loads(raw, object_pairs_hook=pairs,
                            parse_constant=lambda _: (_ for _ in ()).throw(Refusal("nonfinite_number")))
        check(config, args.expected_image, args.expected_port)
    except (ValueError, UnicodeError, OSError, RecursionError):
        # Input/configuration may contain secrets; never echo values or exceptions.
        print('{"verdict":"REFUSE","scope":"configuration_only","runtime_authorized":false}')
        return 1
    print('{"verdict":"PASS","scope":"configuration_only","runtime_authorized":false}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
