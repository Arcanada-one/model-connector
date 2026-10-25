# Maintained full-suite declarations

The ordinary `.arcana/verify.json` declares four `full_test` commands. The native
verifier starts each command in that deployable's directory. SDK commands reach
the root runner through `../../scripts/`; watcher uses `../scripts/`. The runner
anchors its source root to its own file, verifies the exact deployable and working
directory, and rejects traversal, symlinked members and ambient dotenv files.
The native default deadline remains 900 seconds; no profile timeout is extended.

Declarations require independent exact-source review and trusted adoption. Loading
a profile from committed HEAD is not proof of its own admission. Neither a profile
nor a fixture is a runtime authorization or a waiver of another graph obligation.

Membership comes from all committed maintained test files, with physical hashes
checked against the same revision. An uncommitted test or an unknown package suite
type refuses execution. Root membership retains default Vitest, all integration
members, the app E2E and shell/Python/Node/Bats regressions. Historical inventory
omitted the two Billing installer/transaction Python regressions; they remain in
the complete membership instead of silently following that omission.

Root dispatches the exact maintained default Vitest group and each existing
shell/Python/Node/Bats regression through their native runner and result contract.
Its three explicitly reviewed fake-connector/MSW integration members use the
existing integration configuration and exact file selection. Every source member
remains in the plan; actual Vitest result membership must match the selected files.
Python unittest, Node TAP and Bats require nonempty consistent counts; existing
shell validators retain their actual exit-status contract without invented counts.
Missing dependencies, invalid reports, skips, empty counts, timeouts and raw failures
remain non-success, with an unexecuted regression suffix preserved explicitly.

The exact authored `templates/api-connector-scaffold/{{name}}.connector.spec.ts`
remains a separate maintained obligation. It is template source, requiring the
README's nine substitutions, filename rendering and alternate-model replacement;
the literal file is not a default Vitest runtime member. The runner renders this
one declared scaffold in its private evidence directory, retaining all authored
assertions and importing the actual production base connector/interface. The
synthetic fixture uses `.invalid` provider addressing, dummy environment names,
mocked fetch responses and a default fetch refusal. It performs no real provider
fixture capture, registration or environment installation.

Evidence binds the committed README, connector, spec, imported base/interface and
Vitest configuration, records generated source/support hashes, and checks the
actual report against the rendered file identity. The authored member is never
reported as a literally executed filename. Unknown placeholders, changed committed
dependencies, unknown template membership, changed generated source and incomplete
execution evidence refuse success. Other template paths retain their obligations;
there is no template-prefix exclusion. A passing rendered scaffold is source
verification, not provider-adoption or runtime authority.

The seven real external provider/auth/storage/image arms, eight disposable
PostgreSQL/Redis integration members and unconditional app E2E skip stay held as
`not_measured` before child spawn. New integration members are held by default.
No environment opt-in, inherited service URL or caller flag grants access. Children
receive the existing clean private environment, and local tool checks are read-only.
The existing Compose regression renders disposable configuration only; it does not
start or stop containers. Ordinary group success never implies complete root FULL.
SAME Program executes the changed-source root only after exact source review and
trusted adoption; focused dispatcher fixtures are not a root product-suite result.

Python SDK executes complete maintained pytest collection and then its actual
tests, matching file membership and each JUnit testcase identity. TypeScript SDK
executes its complete package Vitest and checks exact file and assertion counts.
Watcher includes all package Vitest tests, an actual build and every maintained
Bats file with complete TAP accounting. These certify existing mock/owned-loopback
contracts, never live backend or deployed watcher behavior. Missing dependencies,
missing results, empty collection, skips, timeouts and failures remain non-success.

## Python verifier environment

The full-suite shell entrypoint selects `python3` from `PATH`; the Python runner
uses that interpreter's `sys.executable` for both SDK pytest collection and
execution. Installing pytest in a different interpreter does not satisfy this
obligation. SDK development dependencies already declare pytest, pytest-asyncio
and the HTTP test doubles in `packages/sdk-python/pyproject.toml`.

Prepare an owned environment from the repository root before starting the native
verifier. Use a newly created environment or a previously verified environment
owned by the same task; do not overwrite another session's environment.

```sh
python3 -m venv packages/sdk-python/.venv
packages/sdk-python/.venv/bin/python -m pip install './packages/sdk-python[dev]'
export PATH="$PWD/packages/sdk-python/.venv/bin:$PATH"
python3 -c 'import sys, pytest, pytest_asyncio; print(sys.executable, pytest.__version__, pytest_asyncio.__version__)'
packages/sdk-python/.venv/bin/python -m pip freeze
```

Retain the installation log, Python version, resolved dependency versions and
installation-input hashes with the native receipt. These commands install declared
test dependencies; they do not run a provider or activate an integration. Start
`verify.py` from the same environment. The SDK's `execution.json` must name this
owned interpreter in both `collection_argv` and execution `argv`, with matching
collected/executed testcase identities and zero failures or skips. A successful
installation alone is not test evidence. Preserve a missing-pytest failure when
recording the repaired run.

For an SDK-only control, use the existing entrypoint from its declared working
directory with the same environment and an already verified private `TMPDIR`:

```sh
(cd packages/sdk-python && bash ../../scripts/graph-full-suite.sh packages/sdk-python)
```

This control verifies the SDK unit only. It does not discharge route, contract,
external-integration or whole-root obligations. Dependency installation and
collection failures remain failures; no missing-runner bypass is introduced.

Each invocation needs an existing owned private `TMPDIR` with mode 0700 and current
effective UID. It creates a unique protected evidence directory and retains actual
per-suite commands, raw logs, exit codes, collection and count evidence. Child
environments receive no ambient credentials, service URLs or integration flags;
their HOME and temporary state are private. Cleanup affects only a timed-out child
process group created by this runner. It never cancels foreign jobs or restarts
services. Evidence directories are retained for the existing executor to collect.

The template explicitly declares `TMPDIR` without a default. Missing or empty
values refuse execution, including when the current directory is private. The
watcher state/audit fixtures create a separate `mkdtemp` directory under the
caller's native temporary root for each test and remove only that directory.
They retain the atomic-write, symlink, malformed-state, audit, serialization and
concurrent-write assertions without requiring or creating a shared `/tmp`.

SAME Program remains the sole whole executor after exact source review and
dependency/environment readiness. The focused `dev-tools/graph-full-suite.test.py`
checks orchestration refusals and parsers with private fixtures; it does not execute
or certify any complete product suite. Root retains the review/adoption decision.
