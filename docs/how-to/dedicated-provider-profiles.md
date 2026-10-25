# Assign dedicated provider credentials to a client

Each application authenticates with its own Model Connector Bearer API key. An
administrator binds that key to a provider profile. The application never receives
the upstream credential.

This release supports registered, versioned credentials for OpenRouter, DeepSeek
and the native TypeSafe JEV adapter. It preserves the existing request-rate cap.
Atomic token/spend budgets, automatic credential failover, per-attempt accounting
and distributed hot rotation require separate verification before use. A request's
`costUsd: 0` does not establish that an unpriced service is free.

## Provision credentials

Keep credential values in the existing Vault or protected deployment files,
outside Git and database records. Inject them into the service through its
existing protected environment mechanism. Do not change environment values to
select a client's key during a request.

Set `PROVIDER_CREDENTIAL_REGISTRY` to JSON metadata with provider-scoped references.
The following example contains no upstream secret:

```json
{
  "app-a-deepseek": {
    "provider": "deepseek",
    "profileId": "app-a",
    "clientKeyIds": ["issued-client-key-id"],
    "versions": { "1": "DEEPSEEK_API_KEY_APP_A_1" }
  },
  "app-a-jev": {
    "provider": "typesafe-jev",
    "profileId": "app-a",
    "clientKeyIds": ["issued-client-key-id"],
    "versions": { "1": "TYPESAFE_API_KEY_APP_A_1" }
  }
}
```

Use the actual MC key ID returned by the machine admin API. References are checked
against the provider, profile and authenticated key ID before any secret is read.
Environment names must use that provider's dedicated prefix. Unknown references,
versions, missing/blank credentials and mismatches refuse execution. They never
select the shared provider key.

## Bind the profile

Use `PATCH /admin/keys/:id/policy` with the existing `x-admin-token`. Browser login
is unnecessary. Send a `policy` object shaped as follows:

```json
{
  "policyVersion": 2,
  "profile": {
    "id": "app-a",
    "revision": "1",
    "accountingBucket": "app-a"
  },
  "providers": ["deepseek", "typesafe-jev"],
  "models": { "mode": "list", "list": ["deepseek-v4-flash", "jev-latest"] },
  "providerKeys": {
    "deepseek": [{ "credentialRef": "app-a-deepseek", "version": "1" }],
    "typesafe-jev": [{ "credentialRef": "app-a-jev", "version": "1" }]
  }
}
```

The first reference in each provider list is explicitly pinned for all normal
retries. Additional entries do not enable automatic failover. Change the policy
revision and first selected binding deliberately when selecting a new version.
All allowed providers require a binding. Profile permissions still intersect the
service's global access gates.

Read metadata back with `GET /admin/keys/:id/policy`. Set request-rate caps using
`PATCH /admin/keys/:id/rate-limit`; the existing guard returns HTTP 429 with
`Retry-After` before reaching the provider. This is a request-frequency cap,
not a token or monetary budget.

Normal DeepSeek calls use `/connectors/deepseek/execute`. Native JEV calls use
`/connectors/typesafe-jev/execute` with a serialized `DecisionRequest/v1` in
`prompt`. Preserve its shadow, `action: none` and unknown-result semantics.
Set `JEV_ENABLED=true`; a dedicated JEV profile does not require the shared
`TYPESAFE_API_KEY`. Dedicated profiles are refused on the separate strict chat
route until its authority/transport integration is qualified.

## Inspect usage and rotate

`GET /admin/keys/:id/usage` returns up to 500 groups from the existing Request
meter, grouped by provider/model, upstream reference/version and accounting
bucket. It sums recorded tokens and cost and exposes no prompt, response, error
or secret. This aggregate is not a provider invoice or complete physical-attempt
ledger. Historical/shared rows have unknown upstream identity; no identity is
invented for them.

Client revocation uses `DELETE /admin/keys/:id`. Authentication caches bcrypt
verification but rereads the database's active flag on each cache hit. Policy
reads also refresh from the database so a stale legacy cache cannot route a newly
assigned dedicated profile through a shared credential.

Provision a successor upstream version before selecting it, preserve the stable
reference and accounting bucket, and verify every serving instance's protected
configuration. Environment injection requires normal service rollout; changing
a host file alone does not refresh running processes. Retain the predecessor
while already dispatched requests drain. Changing or revoking a version does not
recall credentials already sent upstream. Do not claim zero-downtime or immediate
distributed rotation without measurements.

Clients with null or version-1 policies retain their previous shared JEV/DeepSeek
behavior. A rollback that cannot enforce dedicated profiles must disable those
profiles or restore the application's previously authorized dedicated direct
route. It must never borrow another client's credentials or silently use shared
keys.
