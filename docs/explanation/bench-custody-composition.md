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

## Measured dependency defect

The new regression `stop preserves a replacement path rather than unlinking
another owner` currently fails. The unchanged adapter closes Node's named Unix
server before checking the path inode. Closing removes a replacement regular file,
so the later inode check cannot protect it. The raw negative must remain visible;
this composition is a draft and is not admitted. No filesystem rename workaround,
private Node handle mutation, test skip or fixture waiver is introduced. A bounded
adapter ownership/close design and the preserved negative must be independently
reviewed before integration. A pre-close inode check alone does not establish
race-safe ownership.

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
The failing ownership negative is independent of those passing controls.
