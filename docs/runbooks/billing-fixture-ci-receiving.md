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

## Owned consumer lifecycle interface (unregistered)

The maintained required-acquisition callsite now consumes a `BillingFixtureLease`
from `require_billing_acquisition(root, head)`. The default still refuses. No
concrete provider is installed, and no environment or CLI loader selects one.
A manifest, descriptor receipt, `ready` field or subclass test double is not a
registered provider or runtime grant.

The original INFRA adapter must authenticate the current consumer source, actual
runner UID1001, host/job/attempt and custodian PID/start, and retain its authorized
immutable path lifetime. Its `revalidate(root, head, consumer_uid)` returns the
same absolute protected manifest; `release()` performs only owned cleanup and
returns `BillingCleanupStatus.VERIFIED` only after measured owned-descendant
closure and cleanup; UNKNOWN or any other result refuses success. It must bind
held protected ancestor/manifest dev/inode/hash and the same immutable mount
namespace through all owned descendant lifetimes, not only the pathname. Partial acquisition cleanup remains the provider's
responsibility when acquisition throws before returning a lease. AF_UNIX sealed
FD receiving alone does not implement the path-child lifetime.

The consumer retains that lease across inventory and dispatch, validates before
and after each child, preserves bounded paired child/lease or cleanup failures,
and releases exactly once. It continues to apply the existing protected-byte
receiver and SourceCustody checks. Cleanup failure refuses success; it is not
retried or interpreted as resource absence. Offline test doubles qualify only
these consumer methods. The original provider must still receive independent
registration/source review and actual runner lease qualification before a FULL
run. The seventeen runtime obligations remain explicitly unmeasured.

## Source descriptor cleanup failure

SourceCustody drains all remaining descriptors whose retained identity still
matches, even after EBADF or another close error. It attempts each numeric FD at
most once; missing or changed-identity descriptors are not closed or retried.
Changed content/link metadata on the same held inode still refuses dispatch but
does not prevent closing that owned descriptor. Unresolved cleanup raises bounded
CleanupRefused facts. The maintained dispatcher combines those facts with prior
child/provider/source-custody failures; provider release still runs once.

These descriptors remain exclusively consumer-owned. The identity precheck is
not a synchronization primitive or proof against arbitrary concurrent close/reuse
of the same inode; no foreign code is authorized to mutate the retained FD table.
The provider's real descendant/custodian lifetime remains separately required.
