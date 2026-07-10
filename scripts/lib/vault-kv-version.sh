#!/usr/bin/env bash
# vault-kv-version.sh — read the current_version of a Vault KV-v2 secret.
#
# Sourced by scripts/codex-sidecar-entrypoint.sh and
# scripts/codex-oauth-writeback.sh.
#
# Usage (after sourcing):
#   vault_kv_current_version <kv-path>   -> prints integer; exits non-zero on failure
#
# The caller must have VAULT_TOKEN and VAULT_ADDR set.
# If `vault kv metadata get` fails (Vault unreachable, path missing, policy
# error) the function returns 1 without printing anything — callers must
# treat a missing version as "unknown" and decide on fail-safe behaviour.

vault_kv_current_version() {
    local path="$1"
    local raw
    raw="$(vault kv metadata get -format=json "${path}" 2>/dev/null)" || return 1
    # Extract .data.current_version (integer) from JSON using portable awk
    # (2-arg match + RSTART/RLENGTH) — avoids gawk-only 3-arg form.
    printf '%s\n' "${raw}" | awk '
    {
        pat = "\"current_version\":[[:space:]]*[0-9]+"
        if (match($0, pat)) {
            seg = substr($0, RSTART, RLENGTH)
            # Extract trailing digits
            if (match(seg, "[0-9]+$")) {
                print substr(seg, RSTART, RLENGTH)
            }
        }
    }'
    return 0
}

# vault_kv_metadata_field <raw-json> <field>
#
# Extracts a scalar field from the `.data.metadata` object of a
# `vault kv get -format=json` response — e.g. `created_time` (RFC3339
# string) or `version` (integer). Used by
# codex-oauth-staleness-probe.sh (CONN-0218) to age the current version
# without a second Vault round-trip (`vault kv get` already returns the
# current version's metadata inline, unlike `vault kv metadata get`
# which requires a separate nested-versions lookup).
#
# Best-effort line-based awk match (same style as vault_kv_current_version)
# — good enough for the flat scalar fields this needs; does not attempt
# general JSON parsing. Prints nothing and returns 1 on no match.
vault_kv_metadata_field() {
    local raw="$1" field="$2"
    local value
    value="$(printf '%s\n' "${raw}" | awk -v field="${field}" '
    {
        pat = "\"" field "\":[[:space:]]*\"?[^,}\"]*\"?"
        if (match($0, pat)) {
            seg = substr($0, RSTART, RLENGTH)
            sub("\"" field "\":[[:space:]]*", "", seg)
            gsub(/^"|"$/, "", seg)
            print seg
            exit
        }
    }')"
    [ -n "${value}" ] || return 1
    printf '%s\n' "${value}"
}
