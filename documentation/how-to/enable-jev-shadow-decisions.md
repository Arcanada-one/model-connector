# Enable shadow JEV decisions

Keep `JEV_ENABLED=false` until the deployment's admission and provider budget are approved. The connector is disabled by default, publishes no models in the legacy chat catalog, and performs no health/model-list calls in that state.

1. Supply `TYPESAFE_API_KEY` through the deployment's existing secret mechanism. Do not put the key in requests, source files or logs.
2. Set `JEV_ENABLED=true` (exact literal). Allow USE access for `typesafe-jev` through the existing provider policy and authorize the calling API key for this provider/model. A free-only policy cannot use an unpriced model.
3. Send an authenticated request to `POST /connectors/typesafe-jev/execute`. Set `model` to `jev-latest` and `prompt` to the JSON-stringified request in [the contract reference](../reference/jev-decisions.md). Preserve existing billing/idempotency headers. Do not use chat system prompts, tools or `extra` settings with this connector.
4. Inspect the normal connector status and `structured.status`, then retain the request digest, policy ID and observed model with the shadow record. Missing metadata stays unknown. Do not apply the classification as an authorization decision.

The endpoint is fixed to `https://api.typesafe.ai/v1/systemone`; redirects are rejected. Each attempt is capped at 15 seconds. Internal `DecisionService` callers disable retries; the generic endpoint retains its existing configured service retry policy. No live model-list endpoint is assumed.

To revoke, set `JEV_ENABLED=false` and restart the service using its normal deployment process, or deny provider USE access through the existing runtime policy. The adapter rechecks the flag before each attempt; an already dispatched request cannot be unsent. Removing the provider credential also prevents new attempts. This procedure does not install Datarim, host hooks or global agent directories.
