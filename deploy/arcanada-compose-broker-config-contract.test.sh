#!/usr/bin/env bash
# Real-render tests for kc_config_contract top-level and default-network key allowlists.
# Every case writes a Compose file, renders it with the real `docker compose config --format json`
# (no daemon, no network, disposable directory) and feeds that render to the broker's own
# validator, extracted verbatim from deploy/arcanada-compose-broker.sh.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
broker="${KC_CONTRACT_BROKER:-${here}/arcanada-compose-broker.sh}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
fn="$(sed -n '/^kc_config_contract() {/,/^}/p' "$broker")"
[[ -n "$fn" ]] || { echo 'FAIL: kc_config_contract not found' >&2; exit 1; }
old_ref="$(sed -n "s/^readonly KC_OLD_IMAGE_REF='\(.*\)'$/\1/p" "$broker")"
new_ref="$(sed -n "s/^readonly KC_NEW_IMAGE_REF='\(.*\)'$/\1/p" "$broker")"
[[ -n "$old_ref" && -n "$new_ref" ]] || { echo 'FAIL: image refs not found' >&2; exit 1; }

# <variant public|internal> <extra top-level yaml> <extra default-network yaml (indented 4)>
write_compose() {
  local variant="$1" top="$2" net="$3" url nets att
  if [[ "$variant" == public ]]; then
    url='https://auth.arcanada.ai/api/v1/api-keys/knowledge-contract/introspect'
  else
    url='http://auth-arcana-ai-app-1:3200/api/v1/api-keys/knowledge-contract/introspect'
  fi
  {
    cat <<YML
name: knowledge-contract-scrutator
services:
  scrutator:
    image: ${new_ref}
    container_name: knowledge-contract-scrutator-scrutator-1
    restart: unless-stopped
    ports: ["127.0.0.1:8311:8310"]
YML
    if [[ "$variant" == internal ]]; then
      printf '    networks: [default, auth-arcana-ai]\n'
    fi
    cat <<YML
    environment:
      SCRUTATOR_HOST: "0.0.0.0"
      SCRUTATOR_PORT: "8310"
      SCRUTATOR_AUTH_ENFORCE: "true"
      SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL: ${url}
      SCRUTATOR_AUTH_SERVICE_AUDIENCE: urn:arcanada:scrutator:knowledge-contract
      SCRUTATOR_AUTH_SERVICE_SCOPE: kb:knowledge-contract.read
      SCRUTATOR_FEEDER_NAMESPACES: knowledge-contract
      SCRUTATOR_DATABASE_URL: postgresql://kc_scrutator_app:fixture@100.97.136.74:5432/knowledge_contract
    healthcheck:
      test: ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:8310/health"]
      interval: 30s
      timeout: 5s
      retries: 3
YML
    if [[ "$variant" == internal || -n "$net" ]]; then
      printf 'networks:\n'
      if [[ -n "$net" ]]; then printf '  default:\n%s\n' "$net"; fi
      if [[ "$variant" == internal ]]; then
        printf '  auth-arcana-ai:\n    name: auth-arcana-ai_default\n    external: true\n'
      fi
    fi
    if [[ -n "$top" ]]; then printf '%s\n' "$top"; fi
  } >"$work/compose.yml"
}

# Compose prunes unreferenced top-level volumes, secrets and configs and resolves include, so a plain
# render never carries them. Defence in depth against another Compose version or a referenced
# declaration: inject the key into the REAL render of the same file before it reaches the validator.
cat >"$work/inject-docker" <<'SH'
#!/usr/bin/env bash
/usr/bin/docker "$@" | /usr/bin/python3 -I -c '
import json, sys, os
cfg = json.load(sys.stdin)
cfg[os.environ["KC_INJECT_KEY"]] = json.loads(os.environ["KC_INJECT_VALUE"])
json.dump(cfg, sys.stdout)'
SH
chmod 0755 "$work/inject-docker"

# Run the extracted validator on the real render of $work/compose.yml; exit status 0 = accepted.
validate() (
  die() { echo "die: $*" >&2; exit 1; }
  DOCKER=/usr/bin/docker
  if [[ -n "${KC_INJECT_KEY:-}" ]]; then DOCKER="$work/inject-docker"; fi
  COMPOSE_ARGV=(compose -f "$work/compose.yml")
  KC_OLD_IMAGE_REF="$old_ref"; KC_NEW_IMAGE_REF="$new_ref"
  eval "$fn"
  kc_config_contract
) >"$work/out" 2>&1

accepted() { # <name> <variant> <top> <net>
  write_compose "$2" "$3" "$4"
  if ! validate; then sed -n '1,20p' "$work/out" >&2; echo "FAIL: ${1} refused" >&2; exit 1; fi
  echo "PASS: kc_contract_${1}_accepted"
}
refused() { # <name> <variant> <top> <net>
  write_compose "$2" "$3" "$4"
  # The render itself must succeed: this proves the refusal comes from the contract, not from Compose.
  /usr/bin/docker compose -f "$work/compose.yml" config -q >"$work/render.out" 2>&1 ||
    { sed -n '1,20p' "$work/render.out" >&2; echo "FAIL: ${1} does not render" >&2; exit 1; }
  if validate; then echo "FAIL: ${1} accepted" >&2; exit 1; fi
  grep -Fq 'project Compose isolation contract failed' "$work/out" || { echo "FAIL: ${1} not refused by the contract" >&2; exit 1; }
  echo "PASS: kc_contract_${1}_refused"
}

accepted public public '' ''
accepted internal internal '' ''

for v in public internal; do
  for kv in 'volumes|{"data": {}}' 'secrets|{"s": {"environment": "HOME"}}' \
            'configs|{"c": {"content": "x"}}' 'include|[{"path": "other.yml"}]'; do
    KC_INJECT_KEY="${kv%%|*}" KC_INJECT_VALUE="${kv#*|}" refused "${v}_top_injected_${kv%%|*}" "$v" '' ''
  done
  refused "${v}_top_x_ext" "$v" 'x-ext: {a: b}' ''
  refused "${v}_default_driver_opts" "$v" '' $'    driver_opts:\n      com.docker.network.bridge.name: br-x'
  refused "${v}_default_labels" "$v" '' $'    labels:\n      a: b'
  refused "${v}_default_internal" "$v" '' '    internal: true'
  refused "${v}_default_enable_ipv6" "$v" '' '    enable_ipv6: true'
  refused "${v}_default_ipam_config" "$v" '' $'    ipam:\n      config:\n        - subnet: 10.9.0.0/24'
  refused "${v}_default_attachable" "$v" '' '    attachable: true'
  refused "${v}_default_driver_overlay" "$v" '' '    driver: overlay'
done
echo 'PASS: kc_config_contract top-level and default-network allowlists (real renders)'
