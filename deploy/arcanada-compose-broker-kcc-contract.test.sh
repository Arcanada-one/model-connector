#!/usr/bin/env bash
# Real-render tests for kcc_config_contract (KB-CONS-02, kc-corpus instance). Every case writes the Compose
# file, renders it with the real `docker compose config --format json` (no daemon, no network, disposable
# directory) and feeds that render to the broker's own validator, extracted verbatim from
# deploy/arcanada-compose-broker.sh.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
broker="${KCC_CONTRACT_BROKER:-${here}/arcanada-compose-broker.sh}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
fn="$(sed -n '/^kcc_config_contract() {/,/^}/p' "$broker")"
[[ -n "$fn" ]] || { echo 'FAIL: kcc_config_contract not found' >&2; exit 1; }
sha=0123456789abcdef0123456789abcdef01234567
checkout="$work/state/kc-corpus-scrutator"
mkdir -p "$checkout/instances/kc-corpus"
compose="$checkout/instances/kc-corpus/docker-compose.yml"

# <sed-expression applied to the baseline> ; empty = baseline
write_compose() {
  cat >"$compose" <<'YML'
name: kc-corpus-scrutator
services:
  scrutator:
    build:
      context: ../..
      dockerfile: Dockerfile
      target: production
      labels:
        org.opencontainers.image.revision: ${BUILD_SHA:?}
    image: kc-corpus-scrutator:${BUILD_SHA:?}
    container_name: kc-corpus-scrutator-scrutator-1
    labels:
      org.opencontainers.image.revision: ${BUILD_SHA:?}
    env_file: .env
    environment:
      SCRUTATOR_HOST: "0.0.0.0"
      SCRUTATOR_PORT: "8310"
      SCRUTATOR_AUTH_ENFORCE: "true"
      SCRUTATOR_FEEDER_NAMESPACES: "kc-corpus"
      SCRUTATOR_EVIDENCE_EXACT_BYTES: "true"
      SCRUTATOR_EVIDENCE_EXACT_NAMESPACES: '["kc-corpus"]'
      SCRUTATOR_EVIDENCE_EXACT_REQUIRED_NAMESPACES: '["kc-corpus"]'
      SCRUTATOR_EMBEDDING_API_URL: "http://100.90.7.20:8300"
      SCRUTATOR_EMBEDDING_DENSE_SPARSE_ENABLED: "true"
      SCRUTATOR_EMBEDDING_TIMEOUT: "300"
      SCRUTATOR_DATABASE_URL: ${SCRUTATOR_DATABASE_URL:?}
      SCRUTATOR_FEEDER_TOKEN: ${SCRUTATOR_FEEDER_TOKEN:?}
    ports:
      - "127.0.0.1:8312:8310"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:8310/health"]
      interval: 30s
      timeout: 5s
      retries: 3
YML
  printf 'SCRUTATOR_DATABASE_URL=%s\nSCRUTATOR_FEEDER_TOKEN=%s\n' "${DSN:-postgresql://kc_corpus_scrutator_app:fixture@100.97.136.74:5432/kc_corpus}" \
    "${TOKEN:-fixturefixturefixturefixturefixturefixture}" >"$checkout/instances/kc-corpus/.env"
}

mutate() { sed -i "$1" "$compose"; }

# Extracted validator on the real render; exit status 0 = accepted.
validate() (
  die() { echo "die: $*" >&2; exit 1; }
  DOCKER=/usr/bin/docker
  BUILD_SHA="$sha"
  checkout_dir() { printf '%s' "$checkout"; }
  COMPOSE_ARGV=(compose -p kc-corpus-scrutator -f "$compose")
  eval "$fn"
  kcc_config_contract
) >"$work/out" 2>&1

accepted() {
  write_compose; [[ -z "${2:-}" ]] || mutate "$2"
  if ! BUILD_SHA="$sha" DOCKER_HOST=unix:///nonexistent validate; then sed -n '1,20p' "$work/out" >&2; echo "FAIL: ${1} refused" >&2; exit 1; fi
  echo "PASS: kcc_contract_${1}_accepted"
}
refused() {
  write_compose; mutate "$2"
  if [[ -n "${3:-}" ]]; then printf '%s\n' "$3" >>"$compose"; fi
  BUILD_SHA="$sha" DOCKER_HOST=unix:///nonexistent /usr/bin/docker compose -p kc-corpus-scrutator -f "$compose" config -q >"$work/render.out" 2>&1 ||
    { sed -n '1,20p' "$work/render.out" >&2; echo "FAIL: ${1} does not render" >&2; exit 1; }
  if BUILD_SHA="$sha" DOCKER_HOST=unix:///nonexistent validate; then echo "FAIL: ${1} accepted" >&2; exit 1; fi
  grep -Fq 'kc-corpus Compose isolation contract failed' "$work/out" || { echo "FAIL: ${1} not refused by the contract" >&2; exit 1; }
  echo "PASS: kcc_contract_${1}_refused"
}

accepted baseline ''
refused feeder_broadened 's/SCRUTATOR_FEEDER_NAMESPACES: "kc-corpus"/SCRUTATOR_FEEDER_NAMESPACES: "kc-corpus,skills"/'
refused feeder_other_namespace 's/SCRUTATOR_FEEDER_NAMESPACES: "kc-corpus"/SCRUTATOR_FEEDER_NAMESPACES: "kc2-store"/'
refused auth_not_enforced 's/SCRUTATOR_AUTH_ENFORCE: "true"/SCRUTATOR_AUTH_ENFORCE: "false"/'
refused exact_bytes_off 's/SCRUTATOR_EVIDENCE_EXACT_BYTES: "true"/SCRUTATOR_EVIDENCE_EXACT_BYTES: "false"/'
refused exact_namespaces_broadened "s/SCRUTATOR_EVIDENCE_EXACT_NAMESPACES: '\[\"kc-corpus\"\]'/SCRUTATOR_EVIDENCE_EXACT_NAMESPACES: '[\"kc-corpus\",\"skills\"]'/"
refused exact_required_dropped '/SCRUTATOR_EVIDENCE_EXACT_REQUIRED_NAMESPACES/d'
refused port_public 's/"127.0.0.1:8312:8310"/"0.0.0.0:8312:8310"/'
refused port_kc_instance 's/"127.0.0.1:8312:8310"/"127.0.0.1:8311:8310"/'
refused port_shared 's/"127.0.0.1:8312:8310"/"127.0.0.1:8310:8310"/'
refused host_network '/^    ports:/i\    network_mode: host'
refused extra_volume '/^    restart:/i\    volumes: ["/etc:/host-etc:ro"]'
refused privileged '/^    restart:/i\    privileged: true'
refused extra_env_rollback_token '/SCRUTATOR_FEEDER_TOKEN: \${/a\      SCRUTATOR_ROLLBACK_TOKEN: "x"'
refused extra_env_introspect_url '/SCRUTATOR_FEEDER_TOKEN: \${/a\      SCRUTATOR_AUTH_ARCANA_INTROSPECT_URL: "http://x"'
refused extra_env_project_write '/SCRUTATOR_FEEDER_TOKEN: \${/a\      SCRUTATOR_PROJECT_WRITE_NAMESPACE: "kc-corpus"'
refused extra_env_ld_preload '/SCRUTATOR_FEEDER_TOKEN: \${/a\      LD_PRELOAD: "/tmp/x.so"'
refused healthcheck_other_port 's#http://127.0.0.1:8310/health#http://127.0.0.1:8311/health#'
refused container_name_kc 's/container_name: kc-corpus-scrutator-scrutator-1/container_name: knowledge-contract-scrutator-scrutator-1/'
refused build_context_other 's#context: ../..#context: ../../..#'
refused build_target_other 's/target: production/target: base/'
refused image_not_pinned_to_sha 's#image: kc-corpus-scrutator:\${BUILD_SHA:?}#image: kc-corpus-scrutator:latest#'
# A top-level key the contract does not list (volumes, secrets, configs, include, x-*) is refused.
refused top_level_x_extension 's/^services:/x-ext: {a: b}\nservices:/'
refused top_level_volumes_used 's#^    restart: unless-stopped#    restart: unless-stopped\n    volumes: [data:/data]#' $'volumes:\n  data: {}'
refused extra_network 's#^    restart: unless-stopped#    restart: unless-stopped\n    networks: [default, other]#' $'networks:\n  other: {}'

DSN='postgresql://scrutator:fixture@100.97.136.74:5432/arcanada_scrutator' write_compose
DSN='postgresql://scrutator:fixture@100.97.136.74:5432/arcanada_scrutator'
export DSN
if BUILD_SHA="$sha" DOCKER_HOST=unix:///nonexistent validate; then echo 'FAIL: shared database accepted' >&2; exit 1; fi
DSN='postgresql://kc_scrutator_app:fixture@100.97.136.74:5432/knowledge_contract'
write_compose
if BUILD_SHA="$sha" DOCKER_HOST=unix:///nonexistent validate; then echo 'FAIL: KC database accepted' >&2; exit 1; fi
DSN='postgresql://kc_corpus_scrutator_app:fixture@100.97.136.74:5432/kc_corpus?sslmode=disable'
write_compose
if BUILD_SHA="$sha" DOCKER_HOST=unix:///nonexistent validate; then echo 'FAIL: DSN with query accepted' >&2; exit 1; fi
unset DSN
TOKEN=short write_compose
TOKEN=short
export TOKEN
if BUILD_SHA="$sha" DOCKER_HOST=unix:///nonexistent validate; then echo 'FAIL: short feeder capability accepted' >&2; exit 1; fi
echo 'PASS: kcc_contract_database_and_capability_shape_refusals'
echo 'PASS: kcc_config_contract (real renders)'
