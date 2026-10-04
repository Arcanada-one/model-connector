# Default-disabled BENCH custody composition

`composeBenchCustody()` returns no lifecycle and reads no dependencies by default.
Explicit source-only composition accepts the existing CampaignStore and
CheckpointStore, an Ed25519 issuer public key and distinct custodian private key,
the unchanged Auth Arcana JWKS contract, clock and private Unix socket path. It
creates the existing service and trusted adapter without provisioning a campaign,
reading credentials, opening a database or starting a socket. Its serialized
start/stop lifecycle prevents duplicate starts. It is not registered in AppModule
or imported by production startup.

This source switch does not admit runtime activation or expenditure. The original
campaign ledger, issuer/caller/signer separation, hard caps and unknown-consumed
reservations remain governed by the existing classes. Authentic executor,
financial entitlement and provider hard-output receipts remain missing; no
reference or benchmark result is produced.

## Socket lifecycle repair

The immutable `3e61984` preparation and natural CI run retain the original
replacement-file deletion failure (3371/3372 tests). Node22's libuv closes a
pathname-bound Unix socket by unlinking its original bound name before closing
its file descriptor. A pre-close inode observation cannot prevent deletion of a
replacement created between that observation and close.

The adapter now binds in a fresh per-instance private directory (0700) beneath
the existing owner-controlled parent, then exclusively publishes a hardlink to
that same socket inode (0600) at the unchanged signed grant path. This is an
actual filesystem socket, not a symlink, abstract socket, proxy or changed grant.
Node only closes/unlinks the private bound name. Existing grant-path entries are
never overwritten at publication; unsupported hardlinks or an overlong private
address refuse without fallback. The private directory is an adapter-owned
namespace; this is not isolation against a malicious process sharing its Unix
identity and arbitrarily modifying that private namespace.

After closing the listener and its accepted connections, cleanup atomically
renames the public entry into private custody. It checks the captured device,
inode and socket type, rather than deleting a name based on an earlier check.
An already foreign public entry is untouched. A foreign entry swapped during
capture is restored through an exclusive hardlink, never by an overwriting
rename. If restoration is impossible (including an occupied public name or a
captured directory), `BenchSocketCleanupHold` exposes the retained recovery
path. Both entries and their contents remain intact. No recursive cleanup,
financial release, reset, silent success or automatic recovery occurs.

A cleanup hold blocks restart. The source owner may explicitly recover the held
entry and call stop to finish empty-directory cleanup; the fixtures exercise
only their own synthetic entries. The composition clears its running flag before
awaiting cleanup so a failed stop cannot make a later start report stale success.

Controls cover the original replacement-file negative, replacements at the
actual close boundary and before/after atomic capture, occupied restoration,
foreign socket/listener, symlink and nonempty directory preservation, exclusive
publication collision, same-inode/mode publication, direct duplicate-start
refusal, active partial-envelope shutdown, and ordinary stop/restart. They keep
real Node socket and filesystem operations, inserting deterministic fixture-only
interleavings at the relevant syscalls. Removing captured-identity verification
or lifecycle hold handling is detected, and the original adapter is genuinely
RED on its preserved regression. Source controls do not authorize runtime.

Primary references: [Node22 net documentation](https://nodejs.org/docs/latest-v22.x/api/net.html),
[pinned Node22.23.2 libuv close source](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/unix/pipe.c),
[Node22 filesystem documentation](https://nodejs.org/docs/latest-v22.x/api/fs.html),
[Linux rename](https://man7.org/linux/man-pages/man2/rename.2.html) and
[Linux link](https://man7.org/linux/man-pages/man2/link.2.html).

## Offline verification

Run the new source specs and existing authority specs with Node 22, the declared
lockfile tool versions, an owned writable TMPDIR and the existing threads pool:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node node_modules/vitest/vitest.mjs run \
  src/bench-reservation/composition.spec.ts \
  src/bench-reservation/authority.spec.ts --pool=threads --maxWorkers=1
node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit --incremental false
```

TMPDIR must name an owned directory, with mode 0700. The local fixture uses real
classes, synthetic existing fixture key material and a real private Unix socket;
its database pool refuses all access. It never invokes a provider. Default-off,
issuer separation and duplicate-start removal mutations are killed by the specs.
The original failing ownership control is retained and now passes on the repair.
