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

Root execution currently returns native-recognized exit 127 before any suite runs.
Its seven external provider/auth/storage/image integration arms, unconditional app
E2E skip and broader disposable PostgreSQL/Redis execution prerequisites remain
`not_measured`. No environment opt-in can grant or bypass them. This is a prepared
declaration with preserved debt, not a claim that root FULL has become executable
or passed. Those prerequisites need a separately reviewed source/environment repair
in the existing ownership lane before root's runner may change this refusal.

Python SDK executes complete maintained pytest collection and then its actual
tests, matching file membership and each JUnit testcase identity. TypeScript SDK
executes its complete package Vitest and checks exact file and assertion counts.
Watcher includes all package Vitest tests, an actual build and every maintained
Bats file with complete TAP accounting. These certify existing mock/owned-loopback
contracts, never live backend or deployed watcher behavior. Missing dependencies,
missing results, empty collection, skips, timeouts and failures remain non-success.

Each invocation needs an existing owned private `TMPDIR` with mode 0700 and current
effective UID. It creates a unique protected evidence directory and retains actual
per-suite commands, raw logs, exit codes, collection and count evidence. Child
environments receive no ambient credentials, service URLs or integration flags;
their HOME and temporary state are private. Cleanup affects only a timed-out child
process group created by this runner. It never cancels foreign jobs or restarts
services. Evidence directories are retained for the existing executor to collect.

SAME Program remains the sole whole executor after exact source review and
dependency/environment readiness. The focused `dev-tools/graph-full-suite.test.py`
checks orchestration refusals and parsers with private fixtures; it does not execute
or certify any complete product suite. Root retains the review/adoption decision.
