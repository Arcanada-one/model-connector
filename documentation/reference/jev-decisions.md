# Native JEV decisions

The `typesafe-jev` connector accepts `DecisionRequest/v1` and returns `DecisionResult/v1` under the normal connector response's `structured` field. It uses the native System-One endpoint, not chat completions. `DecisionService` is exported by `ConnectorsModule` for internal callers; it always calls `ConnectorsService.execute` with the caller's API key identity and zero retries. External callers use the existing authenticated `POST /connectors/typesafe-jev/execute` path. Existing key policy, provider USE access, billing and timeout gates still apply.

The common request/result envelope separates decision type, policy and provenance from transport. Only the TypeSafe adapter is currently implemented. The sole admitted application mode is `shadow`; every result says `action: none`. This result never authorizes a tool, changes ACLs, loads a skill, delegates work or routes a production request. Native advice must not replace deterministic authorization.

## Routes (CONN-JEV-02)

Transport is expressed as a single `JevRoute` interface (`src/connectors/jev/jev.routes.ts`) with three implementations:

| Route | Status | Request shape | Availability |
|---|---|---|---|
| `direct` | live path shape | `POST /v1/systemone` body `{state,model,questions}` | `available:true` only when a direct key is present and the route is enabled |
| `openrouter` | stub | `POST /api/v1/systemone` same body; errors `{"error":…}` | `available:false` until `TYPESAFE_JEV_OPENROUTER_API_KEY` is set |
| `cloudflare` | stub | `POST /accounts/{id}/ai/run` with `{model,input:{state,questions}}` (path-embedded fork behind a flag); version default `not_observable` | `available:false` until Cloudflare token + account id are set |

An empty route key returns `route_not_configured` without calling the network. Measured envelope fixtures live in `jev.route-fixtures.ts`. OpenRouter/Cloudflare success bodies that were not live-measured are labelled as fixtures for CONN-JEV-09 to replace — the interface does not change. `TYPESAFE_JEV_ROUTES_ENABLED` defaults to `direct`.

## Request

`prompt` is a JSON string containing this envelope:

```json
{
  "version": "DecisionRequest/v1",
  "mode": "shadow",
  "decisionType": "task-routing",
  "policyId": "example-v1",
  "model": "jev-latest",
  "state": "Synthetic task to classify",
  "questions": {
    "tier": {"type": "choice", "instructions": "Choose a capability band", "criteria": {"small": "Simple task", "large": "Complex task"}},
    "complexity": {"type": "score", "instructions": "Rate complexity", "criteria": ["Low", "Medium", "High"]},
    "risk": {"type": "noul", "instructions": "Is the task risky?"}
  }
}
```

The exact upstream body is `{model, state, questions}`. Choice criteria are a map of 2–32 options; Score criteria are an ordered array of 2–32 labels. Optional Noul criteria contain exactly `true` and `false`; their absence is preserved. No options, `none` choice or Noul criteria are invented. State is at most 18,000 characters; there are 1–32 questions. The serialized envelope must fit the existing 100,000-character prompt limit. Unknown envelope/question fields, chat options, alternate model aliases and executable modes are refused before transport.

## Result

The result binds `requestSha256` to the parsed request (including policy, state and criteria), retains `requestedModel`, and uses `observedModel: null` if the provider did not identify itself. Choice retains the selected option, exact confidence and distribution when supplied; absent confidence/distribution is `null`, not zero. Score retains its continuous position in `[0, criteria.length - 1]`; Noul retains its probability in `[0,1]` without rounding. Partial, unexpected, nonfinite or out-of-domain answers invalidate the entire batch. A supplied Choice distribution must cover the declared options, sum to one within `1e-5`, and agree with the winner and supplied confidence.

Malformed output yields `status: unknown`, empty answers and no action; the generic connector envelope has error status. The internal service similarly returns unknown when its connector call is denied or fails. It does not generate a replacement answer. No automatic threshold or application policy is shipped in this adapter.

Usage is separate from decision confidence. Bounded numeric provider usage is retained as `providerUsage`; token counts are normalized only when both `input_tokens` and `output_tokens` are nonnegative safe integers. Otherwise `usageMissing` distinguishes compatibility zeros from measurements. No price is invented: the catalog publishes `typesafe-jev` / `jev-latest` under `modality=decision` (CONN-JEV-01) with unknown pricing, and the existing meter labels unknown pricing. An unpriced decision is not a free decision; free-only key policy refuses it. Successful and error response bodies are limited to 128 KiB before parsing; redirects are refused. Transport/provider errors expose only a fixed category, never provider bodies or parse snippets.

## Verification boundary

The executable fixtures are synthetic and exercise a real `DecisionService → ConnectorsService → JevConnector` path with transport and persistence doubles. They prove native serialization, policy denials, normalization and shadow delivery. They do not establish provider availability, deployed integration, model quality, production consumer action or a measured price. The frozen benchmark is unchanged. Real deployment and consumer adoption require separate admission evidence.

The native wire shape follows the audited standalone JEV producer at Datarim base `730962198bde99c548cc0c803c3f6bb9cdb03c6f` (`plugins/dr-jev-control/scripts/route.py` and `jev_client.py`). The API was not probed during this offline implementation; fixture conformance is not live provider verification.
