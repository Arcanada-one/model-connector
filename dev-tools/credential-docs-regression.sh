#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
README="${REPO_ROOT}/README.md"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
PUBLIC_DOCS=("${README}" "${ENV_EXAMPLE}")

check_model_key() {
    if LC_ALL=C grep -Eq 'mc-[[:alnum:]-]+-[[:xdigit:]]{16,}' "${PUBLIC_DOCS[@]}"; then
        echo "credential policy: realistic Model Connector example key found" >&2
        return 1
    fi
}

check_postgres_uri() {
    if perl -ne '
        $found = 1 if m{postgres(?:ql)?://[^:\s]+:(?!<DB_PASSWORD>)[^@\s]+@}i;
        END { exit($found ? 0 : 1) }
    ' "${PUBLIC_DOCS[@]}"; then
        echo "credential policy: PostgreSQL URI contains a non-placeholder password" >&2
        return 1
    fi
}

check_placeholders() {
    local key_placeholders
    key_placeholders="$(grep -cF '<MODEL_CONNECTOR_API_KEY>' "${README}")"
    test "${key_placeholders}" -ge 3 || {
        echo "credential policy: README must use <MODEL_CONNECTOR_API_KEY> at least three times" >&2
        return 1
    }

    grep -qxF 'DATABASE_URL=postgresql://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:5432/<DB_NAME>' \
        "${ENV_EXAMPLE}" || {
        echo "credential policy: .env.example must use the explicit database placeholders" >&2
        return 1
    }
}

check_safe_usage() {
    grep -qF 'psql "$MODEL_CONNECTOR_DATABASE_URL"' "${README}" || {
        echo "credential policy: README must read the database URL from the environment" >&2
        return 1
    }

    grep -qF "printf 'header = \"Authorization: Bearer %s\"\\n' \"\$MC_API_KEY\"" \
        "${README}" || {
        echo "credential policy: README must pass the API key through curl stdin config" >&2
        return 1
    }
}

run_check() {
    case "${1:-all}" in
        model-key) check_model_key ;;
        postgres-uri) check_postgres_uri ;;
        placeholders) check_placeholders ;;
        safe-usage) check_safe_usage ;;
        all)
            check_model_key
            check_postgres_uri
            check_placeholders
            check_safe_usage
            ;;
        *)
            echo "usage: $0 [model-key|postgres-uri|placeholders|safe-usage|all]" >&2
            return 2
            ;;
    esac
}

run_check "${1:-all}"
