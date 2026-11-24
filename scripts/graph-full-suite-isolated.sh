#!/usr/bin/env bash
# Prepare the private environment required by graph-full-suite.sh under the
# graph verifier's deliberately minimal child environment.
set -euo pipefail
PATH=/usr/bin:/bin
export PATH
if [[ $# != 1 ]]; then
  echo 'FULL_FALLBACK_TEST_REFUSED: exactly one deployable is required' >&2
  exit 1
fi
case "$1" in
  .|packages/sdk-python|packages/sdk-ts|watcher) ;;
  *) echo 'FULL_FALLBACK_TEST_REFUSED: undeclared deployable' >&2; exit 1 ;;
esac

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
if [[ -L "$REPO_ROOT/node_modules" || ! -d "$REPO_ROOT/node_modules" ]]; then
  echo 'FULL_FALLBACK_TEST_REFUSED: owned node_modules directory required' >&2
  exit 1
fi
CACHE_ROOT="$REPO_ROOT/node_modules/.cache/graph-full-suite"
RUNS_DIR="$CACHE_ROOT/runs"
mkdir -p "$RUNS_DIR" "$CACHE_ROOT/pip-cache"
chmod 700 "$CACHE_ROOT" "$RUNS_DIR" "$CACHE_ROOT/pip-cache"
PRIVATE_TMP=$(mktemp -d "$RUNS_DIR/run.XXXXXXXX")
chmod 700 "$PRIVATE_TMP"
mkdir -m 700 "$PRIVATE_TMP/home"
# The private exec/home dir must NOT live under /tmp or any other world-writable directory:
# deploy/prime-first-install.py protected() rejects every path chain with a group/other-writable
# component, so a HOME below /tmp makes test_prime_first_install.py fail with Refusal(custody)
# for a reason that has nothing to do with the code under test. Preserve execution reports in
# PRIVATE_TMP after the run.
#
# AF_UNIX path budget (unit '.'). The exec dir becomes TMPDIR of graph_full_suite.py, which adds its
# own mc-full-<unit>-XXXXXXXX scratch dir, and the deepest socket a maintained root test binds is
#   <exec dir>/mc-full-.-XXXXXXXX/bench-composition-XXXXXX/custody.sock
# (src/bench-reservation/composition.spec.ts; src/bench-reservation/composition.ts requires < 108
# bytes). On a CI runner XDG_RUNTIME_DIR is unset and RUNNER_TEMP is too deep for that budget
# (/opt/arcanada-runners/<runner>/_work/_temp gave a 126-byte socket path and 15 failed tests),
# so the candidates are, in order: XDG_RUNTIME_DIR, $HOME/.mcgs, RUNNER_TEMP. The first existing
# candidate that passes the custody checks AND fits the budget is used; when none fits the wrapper
# refuses. A too-deep base is never used, because the socket tests would then fail for a reason
# that has nothing to do with the code under test.
EXEC_TEMPLATE='/mcgs.XXXXXXXX'
SCRATCH_SUFFIX="/mc-full-${1//\//-}-XXXXXXXX"
SOCKET_SUFFIX='/bench-composition-XXXXXX/custody.sock'
SOCKET_LIMIT=108

refuse() {
  echo "FULL_FALLBACK_TEST_REFUSED: $1" >&2
  exit 1
}

base_problem() { # base_problem <resolved base>; prints why it is not a private exec base, or nothing
  case "$1" in
    /tmp|/tmp/*|/var/tmp|/var/tmp/*)
      echo 'it lives under /tmp or /var/tmp'; return ;;
  esac
  if [[ -L "$1" || ! -O "$1" ]] || (( 8#$(stat -c '%a' -- "$1") & 8#022 )); then
    echo 'it is a symlink, not owned by the caller, or group/other-writable'
  fi
}

fits_socket_budget() { # fits_socket_budget <exec dir or base + template>
  [[ "$UNIT" == . ]] || return 0  # only unit '.' binds AF_UNIX sockets below TMPDIR
  (( ${#1} + ${#SCRATCH_SUFFIX} + ${#SOCKET_SUFFIX} < SOCKET_LIMIT ))
}

home_candidate() { # sets CANDIDATE to $HOME/.mcgs (created 0700 if missing), or WHY to the reason it is skipped
  local base="${HOME:-}/.mcgs"
  if [[ -z "${HOME:-}" || ! -d "$HOME" || -L "$HOME" || ! -O "$HOME" ]]; then
    WHY='HOME is unset, not a directory, a symlink or not owned by the caller'; return
  fi
  if (( 8#$(stat -c '%a' -- "$HOME") & 8#022 )); then
    WHY='HOME is group/other-writable'; return
  fi
  if [[ ! -e "$base" && ! -L "$base" ]]; then
    if ! mkdir -m 700 -- "$base" 2>/dev/null && ! [[ -d "$base" && ! -L "$base" ]]; then
      WHY='$HOME/.mcgs could not be created'; return
    fi
  fi
  if [[ -L "$base" || ! -d "$base" || ! -O "$base" ]] || [[ "$(stat -c '%a' -- "$base")" != 700 ]]; then
    WHY='$HOME/.mcgs is a symlink or not a caller-owned 0700 directory'; return
  fi
  CANDIDATE=$base
}

# Every candidate is checked for custody AND (unit '.') the socket budget. A candidate that fails either
# is skipped with its reason on stderr; the run refuses only when no candidate passes both, so the base
# that is used has always passed every custody check.
UNIT=$1
EXEC_BASE=
for source in XDG_RUNTIME_DIR '$HOME/.mcgs' RUNNER_TEMP; do
  CANDIDATE= WHY=
  case "$source" in
    XDG_RUNTIME_DIR) CANDIDATE=${XDG_RUNTIME_DIR:-} ;;
    '$HOME/.mcgs') home_candidate ;;
    RUNNER_TEMP) CANDIDATE=${RUNNER_TEMP:-} ;;
  esac
  if [[ -z "$WHY" && -z "$CANDIDATE" ]]; then
    WHY='not set'
  elif [[ -z "$WHY" && ! -d "$CANDIDATE" ]]; then
    WHY='not a directory'
  fi
  if [[ -z "$WHY" ]]; then
    CANDIDATE=$(cd -- "$CANDIDATE" && pwd -P)
    WHY=$(base_problem "$CANDIDATE")
  fi
  if [[ -z "$WHY" ]] && ! fits_socket_budget "$CANDIDATE$EXEC_TEMPLATE"; then
    WHY="too deep for the ${SOCKET_LIMIT}-byte AF_UNIX path budget"
  fi
  if [[ -z "$WHY" ]]; then
    EXEC_BASE=$CANDIDATE
    echo "graph-full-suite-isolated: exec base from $source" >&2
    break
  fi
  echo "graph-full-suite-isolated: skipped exec base candidate $source: $WHY" >&2
done
if [[ -z "$EXEC_BASE" ]]; then
  refuse "no private exec base passes custody and the ${SOCKET_LIMIT}-byte AF_UNIX path budget (tried XDG_RUNTIME_DIR, \$HOME/.mcgs, RUNNER_TEMP; the private exec dir may not live under /tmp)"
fi
EXEC_TMP=$(mktemp -d "$EXEC_BASE/mcgs.XXXXXXXX")
chmod 700 "$EXEC_TMP"
trap 'rm -rf -- "$EXEC_TMP"' EXIT
fits_socket_budget "$EXEC_TMP" || refuse "exec dir $EXEC_TMP exceeds the AF_UNIX path budget"

SYSTEM_PATH=$PATH
SYSTEM_PYTHON=$(PATH="$SYSTEM_PATH" command -v python3)
PYTHON_PATH=$SYSTEM_PATH
if [[ "$1" == 'packages/sdk-python' ]] && ! env -i PATH="$SYSTEM_PATH" "$SYSTEM_PYTHON" -c 'import pytest, pytest_asyncio' >/dev/null 2>&1; then
  VENV="$PRIVATE_TMP/python-sdk"
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" PIP_CACHE_DIR="$CACHE_ROOT/pip-cache" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$SYSTEM_PYTHON" -m venv "$VENV"
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" PIP_CACHE_DIR="$CACHE_ROOT/pip-cache" PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$VENV/bin/python" -m pip install -e "$REPO_ROOT/packages/sdk-python[dev]"
  PYTHON_PATH="$VENV/bin:$SYSTEM_PATH"
fi

# pnpm offline (Program DEC-AUP-0197 B9). /usr/bin/pnpm is a corepack shim: under the fresh private HOME
# it finds no pnpm and needs the network, which the B9 sandbox does not have. When
# GRAPH_FULL_SUITE_COREPACK names a directory holding the corepack archive of the packageManager pnpm
# (pnpm-<version>.corepack.tgz, as written by `corepack pack`), the archive must match the sha256 pinned in
# scripts/graph-full-suite-corepack.sha256; it is installed into a private COREPACK_HOME with
# COREPACK_ENABLE_NETWORK=0, and both variables are passed to every later child. Any mismatch refuses.
# Unset: nothing changes (pnpm resolves as before).
corepack_env=()
if [[ -n "${GRAPH_FULL_SUITE_COREPACK:-}" ]]; then
  [[ -d "$GRAPH_FULL_SUITE_COREPACK" && ! -L "$GRAPH_FULL_SUITE_COREPACK" ]] \
    || refuse 'GRAPH_FULL_SUITE_COREPACK must be a directory, not a symlink'
  COREPACK_LOCK="$SCRIPT_DIR/graph-full-suite-corepack.sha256"
  [[ -f "$COREPACK_LOCK" && ! -L "$COREPACK_LOCK" ]] || refuse 'corepack lock file missing'
  pm=$(env -i PATH="$SYSTEM_PATH" "$SYSTEM_PYTHON" -I -c '
import json, sys
print(json.load(open(sys.argv[1])).get("packageManager", ""))' "$REPO_ROOT/package.json") \
    || refuse 'package.json packageManager unreadable'
  [[ "$pm" =~ ^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$ ]] || refuse "packageManager is not an exact pnpm version: $pm"
  pnpm_version=${BASH_REMATCH[1]}
  archive_name="pnpm-$pnpm_version.corepack.tgz"
  read -r pinned_sha pinned_name extra < "$COREPACK_LOCK" || true
  [[ "$pinned_name" == "$archive_name" && -z "${extra:-}" && "$pinned_sha" =~ ^[0-9a-f]{64}$ ]] \
    || refuse "corepack lock does not pin $archive_name"
  archive="$GRAPH_FULL_SUITE_COREPACK/$archive_name"
  [[ -f "$archive" && ! -L "$archive" ]] || refuse "corepack archive $archive_name missing"
  actual_sha=$(sha256sum -- "$archive") || refuse 'corepack archive unreadable'
  [[ "${actual_sha%% *}" == "$pinned_sha" ]] || refuse "corepack archive $archive_name does not match its pinned sha256"
  mkdir -m 700 "$PRIVATE_TMP/corepack"
  corepack_env=(COREPACK_HOME="$PRIVATE_TMP/corepack" COREPACK_ENABLE_NETWORK=0)
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" "${corepack_env[@]}" \
    corepack install -g "$archive" >&2 || refuse 'corepack could not install the pinned pnpm offline'
  got=$(cd -- "$REPO_ROOT" && env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" \
    "${corepack_env[@]}" pnpm --version) || refuse 'pnpm does not run offline after the corepack install'
  [[ "$got" == "$pnpm_version" ]] || refuse "pnpm offline reports $got, expected $pnpm_version"
fi

# Root regressions of unit '.' include .github/graph-admission/tools/graph/test_source_input_contract.py,
# which imports jsonschema. The system /usr/bin/python3 on the CI runners has none, and the setup-python
# interpreter of the workflow is deliberately not on this PATH. Build a private venv from the system
# python (no system site-packages) and install the hash-locked set with --require-hashes --no-deps
# --only-binary=:all: and pip --isolated (no pip.conf or PIP_* environment). Any failure refuses;
# the regression is never skipped.
REGRESSION_LOCK="$SCRIPT_DIR/graph-full-suite-regression.requirements.txt"
if [[ "$1" == '.' ]]; then
  REG_VENV="$PRIVATE_TMP/regression-python"
  reg_env=(env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$SYSTEM_PATH" PYTHONDONTWRITEBYTECODE=1)
  [[ -f "$REGRESSION_LOCK" && ! -L "$REGRESSION_LOCK" ]] || refuse 'regression lock file missing'
  # Optional offline source (tests, air-gapped hosts): GRAPH_FULL_SUITE_WHEELHOUSE names a local directory
  # used with --no-index --find-links. It changes only where the wheels come from; --require-hashes still
  # admits nothing but the exact sha256 bytes pinned in the lock.
  pip_source=()
  if [[ -n "${GRAPH_FULL_SUITE_WHEELHOUSE:-}" ]]; then
    [[ -d "$GRAPH_FULL_SUITE_WHEELHOUSE" && ! -L "$GRAPH_FULL_SUITE_WHEELHOUSE" ]] \
      || refuse 'GRAPH_FULL_SUITE_WHEELHOUSE must be a directory, not a symlink'
    pip_source=(--no-index --find-links "$GRAPH_FULL_SUITE_WHEELHOUSE")
  fi
  "${reg_env[@]}" "$SYSTEM_PYTHON" -I -m venv "$REG_VENV" \
    || refuse 'regression venv could not be created from the system python'
  "${reg_env[@]}" "$REG_VENV/bin/python" -I -m pip --isolated --disable-pip-version-check --no-input \
    install --cache-dir "$CACHE_ROOT/pip-cache" --require-hashes --no-deps --only-binary=:all: \
    "${pip_source[@]}" -r "$REGRESSION_LOCK" \
    || refuse 'hash-locked regression dependencies could not be installed'
  "${reg_env[@]}" "$REG_VENV/bin/python" -I -c '
import sys, jsonschema, importlib.metadata as md
venv = sys.argv[1]
assert jsonschema.__file__.startswith(venv + "/"), jsonschema.__file__
assert md.version("jsonschema") == "4.23.0", md.version("jsonschema")
' "$REG_VENV" || refuse 'regression venv does not provide the locked jsonschema'
  PYTHON_PATH="$REG_VENV/bin:$PYTHON_PATH"
fi

# Root Vitest/integration arms import @prisma/client. A clean install with
# ignored build scripts leaves the client ungenerated; generate into the owned
# node_modules before measurement when prisma is present (dummy URL — generate
# does not connect). Fixture harnesses without prisma skip this step.
if [[ "$1" == '.' && -x "$REPO_ROOT/node_modules/.bin/prisma" ]]; then
  env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$PYTHON_PATH" CI=1 "${corepack_env[@]}" \
    PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1 FORCE_COLOR=0 \
    DATABASE_URL='postgresql://prisma-generate:prisma-generate@127.0.0.1:5432/prisma_generate' \
    bash -lc "cd -- $(printf '%q' "$REPO_ROOT") && ./node_modules/.bin/prisma generate" \
    || { echo 'FULL_FALLBACK_TEST_REFUSED: prisma generate failed' >&2; exit 1; }
fi

# Program may pass the fixed Model Connector candidate-store profile to this verifier step.
# Revalidate it here, then forward only these named values through env -i to the full-suite child.
# No arbitrary inherited environment is carried into the runner.
disposable_store_env=()
if [[ -n "${GRAPH_DISPOSABLE_STORE_PROFILE:-}" ]]; then
  [[ "$1" == '.' && "${GITHUB_REPOSITORY:-}" == 'Arcanada-one/model-connector' \
     && "$GRAPH_DISPOSABLE_STORE_PROFILE" == 'model-connector-disposable-store-v1' ]] \
    || refuse 'disposable-store profile is not bound to Model Connector root suite'
  [[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] \
    || refuse 'disposable-store run namespace is invalid'
  [[ "${DATABASE_URL:-}" =~ ^postgresql://test:test@127\.0\.0\.1:([0-9]+)/connector_test$ ]] \
    || refuse 'disposable PostgreSQL URL is outside the fixed loopback profile'
  pg_port=${BASH_REMATCH[1]}
  (( 10#$pg_port >= 1 && 10#$pg_port <= 65535 )) || refuse 'disposable PostgreSQL port is invalid'
  [[ "${REDIS_HOST:-}" == '127.0.0.1' && "${REDIS_PORT:-}" =~ ^[0-9]+$ ]] \
    || refuse 'disposable Redis endpoint is outside the fixed loopback profile'
  (( 10#$REDIS_PORT >= 1 && 10#$REDIS_PORT <= 65535 )) || refuse 'disposable Redis port is invalid'
  [[ "${REDIS_PREFIX:-}" == "mc-ga-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}:" ]] \
    || refuse 'disposable Redis namespace is not run-bound'
  expected_socket="${RUNNER_TEMP:-}/graph-admission/mc-owned-postgres/socket"
  [[ -n "${RUNNER_TEMP:-}" && "${BENCH_OWNED_TEST_PG_SOCKET:-}" == "$expected_socket" \
     && -d "$expected_socket" && ! -L "$expected_socket" \
     && ! -L "${RUNNER_TEMP}/graph-admission" \
     && ! -L "${RUNNER_TEMP}/graph-admission/mc-owned-postgres" ]] \
    || refuse 'owned PostgreSQL socket path is absent or indirect'
  disposable_store_env=(GITHUB_REPOSITORY="$GITHUB_REPOSITORY"
    GRAPH_DISPOSABLE_STORE_PROFILE="$GRAPH_DISPOSABLE_STORE_PROFILE"
    DATABASE_URL="$DATABASE_URL" REDIS_HOST="$REDIS_HOST" REDIS_PORT="$REDIS_PORT"
    REDIS_PREFIX="$REDIS_PREFIX" BENCH_OWNED_TEST_PG_SOCKET="$BENCH_OWNED_TEST_PG_SOCKET"
    RUNNER_TEMP="$RUNNER_TEMP")
elif [[ -n "${DATABASE_URL:-}${REDIS_HOST:-}${REDIS_PORT:-}${REDIS_PREFIX:-}${BENCH_OWNED_TEST_PG_SOCKET:-}" ]]; then
  refuse 'store service variables require the fixed disposable-store profile'
fi

set +e
env -i HOME="$PRIVATE_TMP/home" TMPDIR="$EXEC_TMP" PATH="$PYTHON_PATH" CI=1 "${corepack_env[@]}" \
  PYTHONDONTWRITEBYTECODE=1 NO_COLOR=1 FORCE_COLOR=0 "${disposable_store_env[@]}" \
  bash "$SCRIPT_DIR/graph-full-suite.sh" "$1"
status=$?
shopt -s nullglob
for artifact in "$EXEC_TMP"/mc-full-*; do
  cp -a -- "$artifact" "$PRIVATE_TMP/"
done

# The suite printed "Full-suite evidence: <EXEC_TMP>/mc-full-*/execution.json", but the EXIT trap removes
# EXEC_TMP before the caller (verify.py) reads that line, so the document was always "unreadable" there.
# Name the surviving private copy; the caller takes the LAST such line. The copy is byte-identical, so this
# corrects which document is read; it adds no field and changes no verdict or exit status.
copies=("$PRIVATE_TMP"/mc-full-*/execution.json)
if (( ${#copies[@]} == 1 )) && [[ -f "${copies[0]}" && ! -L "${copies[0]}" ]]; then
  echo "Full-suite evidence: ${copies[0]}"
  # On a non-zero status, print a bounded failure digest on stdout. The caller keeps this output in the
  # retained verifier-out log, which survives the runner's cleanup when the private copy does not. Only argv,
  # exit code, duration and the last 80 log lines of each FAILED execution (verdict neither verified nor
  # not_measured) are printed, after redaction; no environment value is ever printed. A not-measured run
  # (status 124/127) with no failed execution prints nothing. The digest is capped at 64 KiB.
  if (( status != 0 )); then
    "$SYSTEM_PYTHON" -I - "${copies[0]}" "$status" <<'DIGEST' || echo 'graph-full-suite-isolated: failure digest unavailable'
import json, os, re, stat, sys
CAP, TAIL = 65536, 80
doc_path, status = sys.argv[1], int(sys.argv[2])
base = os.path.dirname(doc_path)
SECRET = [
    (re.compile(r'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)', re.S), '[REDACTED PRIVATE KEY]'),
    (re.compile(r'\A.*?-----END [A-Z0-9 ]*PRIVATE KEY-----', re.S), '[REDACTED PRIVATE KEY]'),
    (re.compile(r'(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[g-zG-Z+/])[A-Za-z0-9+/]{40,}={0,2}'), '[REDACTED]'),
    (re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|mun_sk_[A-Za-z0-9_-]{8,}'
                r'|sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})'), '[REDACTED]'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'), '[REDACTED JWT]'),
    (re.compile(r'(?i)\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}'), r'\1\2[REDACTED]'),
    (re.compile(r'(://[^/\s:@]+):[^@\s/]+@'), r'\1:[REDACTED]@'),
    (re.compile(r'(?i)\b((?:[a-z0-9_]*_)?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key'
                r'|client[_-]?secret|authorization|credentials?|cookie|session|key)["\']?\s*[:=]\s*)(["\']?)[^\s"\',;}]+'), r'\1\2[REDACTED]'),
    (re.compile(r'^(\s*(?:export\s+)?[A-Z_][A-Z0-9_]*=)\S.*$', re.M), r'\1[REDACTED]'),
]
def redact(text):
    for rx, rep in SECRET:
        text = rx.sub(rep, text)
    return text
def arg(a):
    a = str(a)
    return re.sub(r'^([A-Za-z_][A-Za-z0-9_]*=).*$', r'\1[REDACTED]', a, flags=re.S)
def tail(raw):
    if not isinstance(raw, str):
        return ['(no raw log named)']
    p = os.path.join(base, os.path.basename(raw))
    try:
        st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode):
            return ['(raw log is not a regular file)']
        with open(p, 'rb') as f:
            f.seek(max(0, st.st_size - 262144))
            lines = f.read().decode('utf-8', 'replace').splitlines()[-TAIL:]
    except OSError:
        return ['(raw log unreadable)']
    return redact('\n'.join(lines)).splitlines()
try:
    st = os.lstat(doc_path)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError
    with open(doc_path) as f:
        doc = json.load(f)
except (OSError, ValueError):
    print('graph-full-suite-isolated: failure digest unavailable (execution document unreadable)')
    sys.exit(0)
def failed(ex):
    return isinstance(ex, dict) and ex.get('verdict') not in ('verified', 'not_measured')
rows = [r for r in (doc.get('results') or []) if isinstance(r, dict)]
if status in (124, 127) and not any(failed(ex) for r in rows for ex in (r.get('executions') or [])):
    sys.exit(0)
out = ['=== graph-full-suite failure digest (argv, exit, duration, last %d log lines; redacted; capped at %d bytes) ===' % (TAIL, CAP),
       'unit=%s head=%s exit_code=%s' % (doc.get('unit'), doc.get('head'), doc.get('exit_code'))]
for row in rows:
    out.append('suite %s: %s; held %d; %s' % (row.get('suite'), row.get('verdict'), len(row.get('held_members') or []),
                                                redact(str(row.get('reason') or ''))[:300]))
    for ex in row.get('executions') or []:
        if not failed(ex):
            continue
        out.append('  execution %s: exit %s, %ss: %s' % (ex.get('verdict'), ex.get('exit_code'), ex.get('duration_s'),
                                                          redact(' '.join(arg(a) for a in (ex.get('argv') or [])))))
        out.extend('    | ' + line for line in tail(ex.get('raw_log')))
text, used = [], 0
for line in out:
    size = len(line.encode('utf-8')) + 1
    if used + size > CAP - 64:
        text.append('[digest truncated at %d bytes]' % CAP)
        break
    text.append(line)
    used += size
print('\n'.join(text))
DIGEST
  fi
fi
exit "$status"
