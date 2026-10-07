# Rotate a credential without changing its account

`POST /admin/keys/:id/rotate` changes the secret of an existing Model Connector
identity. Its key ID, name, policy, rate limit, balance, held funds, request
history and credit ledger remain attached to the same account. The route uses
the existing admin guard and returns the new secret once with
`Cache-Control: no-store`.

Creating a second key and revoking the first creates a different account. It
does not transfer a funded balance or its ledger and is not an equivalent
rotation. A manual database update bypasses the management interface.

## Request

```json
{
  "actor": "credential-custodian",
  "reason": "Scheduled credential rotation",
  "expectedActive": true,
  "reactivate": false
}
```

Authenticate with the existing `x-admin-token` header. `actor` is required audit
metadata, not a new source of authorization. `reason` is required and must be a
single line. Unknown fields, including account or policy changes, are rejected.
Never put a credential in either audit field.

Inspect `GET /admin/keys/:id` before rotating. A stale activity expectation or a
concurrent credential change returns `409` without returning a new secret.
The successful response is `200` with `id`, `name`, `active`, and `key`. Capture
`key` directly into protected storage; never print the response or include it in
a receipt. The old credential stops authenticating immediately because rotation
flushes the verified-key cache.

## Recover a revoked funded identity

A revoked identity is refused by default. An authorized custodian can explicitly
request `expectedActive: false` and `reactivate: true` to rotate its secret and
restore that same identity. Reactivation of an already active identity is
rejected. Recovery issues a fresh secret; it never restores acceptance of the
old secret or creates a replacement credit balance.

Verify the original account and its ledger before and after recovery, install
the fresh secret through the normal protected credential/deployment path, and
verify old-secret rejection and new-secret acceptance. Preserve unrelated
consumers and do not use a gift or repeated credit to imitate a transfer.

Rotation does not verify a consumer's JWT ingress or authorize a service restart.
Deployment and runtime acceptance require a release containing this route and
separate live receipts. Tests with fixture storage are not a production database
or financial-delivery receipt.
