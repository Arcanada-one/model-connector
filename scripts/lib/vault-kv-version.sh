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
