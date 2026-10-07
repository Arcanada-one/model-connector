# Prepare separate account-receipt source dependencies

The existing disabled installer and its fifteen-module contract are unchanged.
`billing-receiving-composition.json` is the exact separate Billing composition:
the original fifteen modules plus `receipts.py`. The independently pinned
`receiving.py` adapter is not silently counted as one of those sixteen modules.
`qualify_composition` checks supplied bytes without importing or executing them.

`prepare_account_verifier` has a separate asynchronous, role-aware byte resolver
for `account-designation` and `account-checkpoint`. It awaits typed evidence and
binds account, caller, task, source head, binary, checkpoint, receipt digest,
original issuer principal, current revocation reference and expiration. Boolean
or Promise-shaped charging-policy/wire-bounds verification is incompatible.
Both original issuer principals must be distinct. Resolver errors expose no
receipt or exception body; a missing resolver refuses.

The resulting synchronous Billing byte callback is source preparation only.
It rechecks expiry and exact bytes but supplies no transaction lease. The
incumbent must resolve current revocation again at the actual atomic transaction
boundary and bind these source bytes to its admitted executable. Injected tests
are not authentic issuers. The maintained native resolver, designated binary and
current original account/primary/checkpoint receipts remain unavailable.

No loader, filesystem discovery, Journal opening, reserve, signing, send,
credential access or provider call is added. All thirteen existing references
remain null and activation stays disabled. This source must pass independent
review, current whole admission and exact CI before any separate adoption.

## Disabled image packaging

The production image includes only `bench-account-receiving.py`, the unchanged
`bench-monetary-v2.disabled.json`, and the offline package verifier under
`/app/deploy`. It installs `python3` with its standard library; `python3-minimal` alone omits required modules such as `json`. The build
requires the existing `MC_BUILD_SHA` argument and creates an exclusive provenance
receipt binding that revision to the three actual file hashes. Files are owned by
root and read-only to the existing non-root connector user. No deploy broker or
financial execution entrypoint is copied or started.

The ordinary Docker CI verifies the actual candidate image with networking disabled
and a read-only filesystem:

```sh
docker run --rm --network=none --read-only --entrypoint python3 \
  model-connector-e2e -B /app/deploy/bench-receiving-package.py verify "$GITHUB_SHA"
```

A successful readback proves file presence, exact bytes, interpreter importability,
and the supplied build revision only. It is local image custody metadata, not a
signed issuer attestation or proof that the supplied revision is authentic. The
registry image identity and ordinary CI source revision must be bound separately
by the existing deployment receipt. All thirteen protected references remain NULL;
financial designation, cap resolution, executable authorization, native issuer,
Journal and transaction composition remain unresolved and disabled. Rollback uses
the existing reviewed image/deployment route to the prior image; there is no host
installation or account mutation in this packaging change.
