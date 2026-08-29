#!/usr/bin/env bash
#
# ARAS-0058 — assert that operationally load-bearing env vars are DECLARED in
# the template the deploy path builds `.env` from.
#
# `BILLING_ENFORCED` existed nowhere outside `src/`: not in `.env.example`, not
# in `docker-compose.yml`, not in `deploy/`, not in CI. It was set by hand on
# the production container. The next deploy that rebuilt the env from the
# template would have silently disabled billing, and the failure mode is
# SUCCESSFUL FREE SERVICE — no error, no alert, no customer complaint, and a
# ledger that still looks entirely normal because a charge nobody gated is
# still a charge of the correct amount. This is the auth-arcana pattern,
# on the money path.
#
# A grep in CI is a weak mechanism for a strong requirement, and it is chosen
# deliberately over the alternatives: a boot-time assertion would turn a
# missing declaration into an outage, and a schema default (which already
# exists) is exactly what makes the omission invisible. The point is to fail
# the PR that drops the declaration, not the deploy that inherits it.
#
# Usage: bash dev-tools/env-declaration-parity.sh
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"

# Vars whose ABSENCE from a rebuilt env is silent and expensive.
#
# Not every schema key belongs here — most have a default that is correct when
# unset, and listing them all would make this a chore that gets weakened rather
# than a rule that gets kept. The bar for inclusion: if this var goes missing,
# does the service keep serving while doing the WRONG thing? Money and access
# controls qualify. A timeout does not.
REQUIRED_DECLARATIONS=(
    BILLING_ENFORCED
    BILLING_LIVE_MODE
    BILLING_MAX_REQUEST_COST_USD
    BILLING_RECONCILE_ENABLED
)

fail=0

for var in "${REQUIRED_DECLARATIONS[@]}"; do
    if ! grep -Eq "^${var}=" "${ENV_EXAMPLE}"; then
        echo "env-declaration-parity: ${var} is not declared in .env.example." >&2
        echo "  It is read by src/ and defaulted by the schema, so its absence here is" >&2
        echo "  invisible: the service keeps serving with the wrong setting. Declare it." >&2
        fail=1
    fi
done

# The declaration is only worth anything if the code still reads it. A var
# declared in the template and read nowhere is dead config that will be
# deleted by the next person who tidies up — and re-introduce the gap.
for var in "${REQUIRED_DECLARATIONS[@]}"; do
    if ! grep -rq "${var}" "${REPO_ROOT}/src"; then
        echo "env-declaration-parity: ${var} is declared in .env.example but read nowhere in src/." >&2
        echo "  Remove it from REQUIRED_DECLARATIONS, or wire it up." >&2
        fail=1
    fi
done

if [ "${fail}" -ne 0 ]; then
    exit 1
fi

echo "env-declaration-parity: ${#REQUIRED_DECLARATIONS[@]} required declaration(s) present."
