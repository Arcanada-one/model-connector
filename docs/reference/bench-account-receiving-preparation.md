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
