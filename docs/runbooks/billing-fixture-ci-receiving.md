# Protected Billing fixture CI receiving

The maintained root FULL workflow invokes `scripts/graph-full-suite.sh . --require-billing-fixture-acquisition`. The measured callsite has no registered private transport/lease adapter. It therefore returns exit127, records `billing_fixture_acquisition_adapter_not_supplied` as NOT_MEASURED, and dispatches zero suites. The bounded diagnostics preserve this receiving result. No manifest, environment flag or local four-case PASS supplies CI authority.

The separate explicit `--billing-fixture-manifest /absolute/private/input.json` input validates original pinned offline fixture bytes and retains/revalidates/release consumer descriptors. This source-only interface does not satisfy the maintained CI acquisition gate or guarantee immutability during a path-based child. Local UID1002 receiving is separate from actual CIUID1001.

## Producer and adapter requirements

INFRA owns protected source production and transport. The existing CI job must receive an actual authorized private delivery under its own UID1001, not a public artifact or repository copy. Supply the concrete existing acquire/revalidate/release adapter and authority receipt, exclusive job/attempt identity, absolute private manifest path and SHA256, original repository/revision and all fifteen file identities/hashes, enforced immutable execution lifetime, expiry and cleanup reserve, and resource-specific cleanup owner/status. A borrowed local source path is insufficient. Credentials, account changes, sudo/chown and blanket UID overrides are excluded.

When that adapter exists, integrate its actual returned lease in the maintained gate; revalidate before dispatch and after the child, release consumer-owned descriptors in finally, and invoke only the producer's authorized cleanup. Preserve UNKNOWN if resource absence cannot be established. Never remove borrowed producer files.

## Qualification and reversal

Require actual UID1001 positive receiving and controls for missing adapter, wrong owner/attempt, expired lease, symlink/FIFO, altered or replaced module, custody loss after child success, child failure cleanup and foreign resource collision. Keep the seventeen held integrations explicit. Until qualified, do not claim FULL, resulting-main admission, deployment or runtime accounting.

Reverse if a successor dispatches on missing acquisition authority, accepts local/path-only custody as CI lease, exposes private bytes or deletes foreign resources: restore this explicit refusal and preserve evidence. This document and refusal do not grant or register an adapter.

## Dispatch failure receiving

If the child fails and post-dispatch custody is lost, the bounded `DispatchFailure.failure_facts` preserves both the canonical child exception category or returned exit status and the custody refusal. Child exception messages, arbitrary class names and private excerpts are not included. The maintained diagnostics retain these typed facts. A successful child followed by custody loss remains refused; a failed precheck makes zero child calls. Consumer descriptors are released once through the outer finally.
