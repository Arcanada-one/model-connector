# Suppress provider retries for a direct execute request

Set `maxRetries` to `0` in a request to either `POST /execute` (with an explicit
`connector`) or `POST /connectors/:name/execute`. The shared HTTP DTO preserves
the value and the existing connector service makes one provider attempt even
when that attempt returns a retryable error. The API accepts only the number
`0`; positive, negative, fractional, string and null values are rejected.
Omitting the field preserves the configured server retry policy.

For the offline preparation of the Anthropic precondition probe, use this body:

```json
{
  "connector": "anthropic",
  "model": "claude-fable-5-1",
  "prompt": "ping",
  "maxRetries": 0,
  "extra": { "max_tokens": 1 }
}
```

Use the existing API-key authentication and an `Idempotency-Key` through the
normal authenticated request path after its account and deployment are admitted.
Never log the authentication header. Reusing the same idempotency key with the
same direct request uses the existing intent replay behavior.

This field limits the connector service retry loop. It is not a monetary budget,
a caller-wide request counter, or a guarantee against retries by other clients.
A `profile` can dispatch multiple connectors and `output_format` can invoke the
separate output-repair middleware; omit both for the direct precondition probe.
`maxBudgetUsd` is not an Anthropic provider spending cap. An estimated reservation
and a nonnegative account balance do not prove a hard upstream cost bound.

The live probe remains held until the provider credential, funded account,
hard spend bound, canonical admission and deployment are qualified. No purchase,
top-up or live provider invocation is part of this source change. Roll back by
reverting the change through a PR; requests without the new field are unaffected.
