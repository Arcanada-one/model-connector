# How to Discover Models via the Catalog Endpoint

> **How-to** — this page shows how an agent uses the `GET /connectors/catalog`
> endpoint to discover and route to a model. It documents the request parameters
> and response schema inline, then walks through a complete consumer example.

---

## Overview

The catalog endpoint returns a snapshot of all models available across every
registered connector. A consumer sends a single HTTP request and receives a
structured list it can use to route requests — picking the right model for the
right workload without hard-coding connector names.

**Endpoint:** `GET /connectors/catalog`  
**Authentication:** Bearer token (same `Authorization` header as all other
endpoints — the `AuthGuard` is applied at the controller level).  
**Content-Type:** `application/json`

---

## Query Parameters

All parameters are optional. When omitted, the full catalog is returned.

| Parameter    | Type   | Description |
|--------------|--------|-------------|
| `free`       | `true` \| `1` | Return only models on the free tier. |
| `cheap`      | `true` \| `1` | Return free models **and** models with a low price multiplier (`<= 1`). |
| `capability` | enum   | Return only models whose connector supports the named capability. Accepted values: `supportsJsonSchema`, `supportsTools`, `supportsStreaming`. |

Filters compose by AND: `?free=true&capability=supportsJsonSchema` returns only
free models that also support JSON schema output.

---

## Response Schema

```json
{
  "models": [
    {
      "connector": "openmodel",
      "model": "deepseek-v4-flash",
      "free": true,
      "cheap": true,
      "priceMultiplier": 0,
      "rateLimits": null,
      "capabilities": {
        "supportsStreaming": false,
        "supportsJsonSchema": true,
        "supportsTools": false
      },
      "routing": {
        "connector": "openmodel",
        "model": "deepseek-v4-flash"
      },
      "available": true
    }
  ],
  "generatedAt": "2026-06-21T17:00:00.000Z",
  "count": 1
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `connector` | `string` | Connector name (matches the `connector` field in `/execute` requests). |
| `model` | `string` | Model identifier passed as `model` in execute requests. |
| `free` | `boolean` | `true` when the model is on the connector's free tier. |
| `cheap` | `boolean` | `true` when `free === true` **or** when the price multiplier is `<= 1`. |
| `priceMultiplier` | `number \| null` | Relative cost unit. `0` = free, `1` = standard, `null` = unknown (connector does not expose price data). |
| `rateLimits` | `object \| null` | `{ requestsPerMinute, tokensPerMinute }` when the connector exposes live rate-limit data. `null` when unknown — values are **never** invented. |
| `capabilities.supportsStreaming` | `boolean` | Whether the connector supports streaming responses. |
| `capabilities.supportsJsonSchema` | `boolean` | Whether the connector accepts a JSON schema for structured output. |
| `capabilities.supportsTools` | `boolean` | Whether the connector supports tool/function calling. |
| `routing.connector` | `string` | The connector name to use in the `/execute` or `/connectors/:name/execute` path. |
| `routing.model` | `string` | The model id to pass in the execute request body. |
| `available` | `boolean` | `true` when the connector's `getStatus()` reports `healthy: true` at catalog-generation time. |
| `generatedAt` | `string` | ISO-8601 timestamp of when the catalog snapshot was generated. |
| `count` | `number` | Number of model entries returned (after filters). |

### Price multiplier semantics

- `priceMultiplier === 0` → free tier, zero cost per request.
- `priceMultiplier === 1` → standard cost baseline.
- `priceMultiplier > 1` → premium model, higher cost.
- `priceMultiplier === null` → connector does not publish pricing data; treat as unknown.

Currently only the `openmodel` connector exposes structured price data via its
internal catalogue (`OPENMODEL_CATALOGUE`). All CLI connectors (claude-code,
codex, cursor) return `null` because their cost depends on the operator's
subscription, not a per-call price.

### Free model detection (CONN-0233)

`free: true` is set by the service when either condition holds:

1. **`freeModels[]` membership** — the connector's `getCapabilities()` includes the
   model id in its `freeModels` array.
2. **`priceMultiplier === 0`** — the openmodel catalogue assigns the model zero cost.

Connectors populate `freeModels[]` using two strategies:

| Connector | Strategy | Evidence basis | Reviewed |
|-----------|----------|----------------|---------|
| **groq** | Curated static list | Groq API is free-tier (rate-limited via console.groq.com free plan). All models in the connector are accessible. | 2026-06-22 |
| **gemini** | Curated static list | Gemini CLI uses Google AI Studio OAuth (free quota). All models in the connector are accessible via the free CLI tier. | 2026-06-22 |
| **grok** | Explicit empty list | xAI has no free tier — all models are pay-per-token (docs.x.ai/docs/pricing). | 2026-06-22 |
| **openrouter** | Dynamic API fetch | Fetches `GET https://openrouter.ai/api/v1/models` on startup; marks models free when `pricing.prompt === "0" && pricing.completion === "0"` **or** the model id ends with `:free`. Cache is updated once at module init via `refreshFreeModels()`. | 2026-06-22 |
| **openmodel** | Price catalogue (`priceMultiplier === 0`) | `OPENMODEL_CATALOGUE` assigns `price_multiplier: 0` to free-tier models. No `freeModels[]` needed — the service equation covers it. | pre-CONN-0233 |

**Anti-fabrication guarantee:** every free flag has provider evidence. A model is
only marked free when it is verifiably free-tier at the detection date cited above.
When a provider's status is uncertain for a given model, it is left unset (honest
partial coverage beats a fabricated flag). The Vitest suite asserts that every entry
in `freeModels[]` also appears in `models[]`, preventing silent phantom entries.

**OpenRouter dynamic refresh:** the initial fetch is fire-and-forget from `OnModuleInit`.
If the OpenRouter `/api/v1/models` API is unreachable at boot, `freeModels` remains
empty for that session and the connector still serves all static paid models normally.
No catalog request is ever blocked by a failed refresh.

### Rate limits

No connector currently exposes live RPM/TPM data to the Model Connector API.
`rateLimits` is therefore `null` for every model in the current implementation.
When a future connector implements rate-limit reporting, the field will be
populated with `{ requestsPerMinute: N, tokensPerMinute: M }` (both may be
individually `null` if only one dimension is known).

---

## Error responses

| HTTP status | `error` field | Cause |
|-------------|--------------|-------|
| `400` | `validation_error` | An unknown `capability` value was passed (e.g. `supportsUnicorns`). |
| `401` | (standard auth error) | Missing or invalid Bearer token. |

---

## Consumer example: picking a free model for low-reasoning / watching / email-checking

An agent performing **low-reasoning, watching, or email-checking** workloads
needs a model that is free (zero cost), available, and supports JSON schema
output so it can return structured results. The workflow is:

### Step 1 — Discover free models that support JSON schema

```http
GET /connectors/catalog?free=true&capability=supportsJsonSchema
Authorization: Bearer <your-api-key>
```

**Example response:**

```json
{
  "models": [
    {
      "connector": "openmodel",
      "model": "deepseek-v4-flash",
      "free": true,
      "cheap": true,
      "priceMultiplier": 0,
      "rateLimits": null,
      "capabilities": {
        "supportsStreaming": false,
        "supportsJsonSchema": true,
        "supportsTools": false
      },
      "routing": {
        "connector": "openmodel",
        "model": "deepseek-v4-flash"
      },
      "available": true
    }
  ],
  "generatedAt": "2026-06-21T17:00:00.000Z",
  "count": 1
}
```

### Step 2 — Filter to available models in the agent

```python
import httpx

resp = httpx.get(
    "https://model-connector.arcanada.ai/connectors/catalog",
    params={"free": "true", "capability": "supportsJsonSchema"},
    headers={"Authorization": f"Bearer {api_key}"},
)
resp.raise_for_status()
data = resp.json()

# Pick the first available model.
candidates = [m for m in data["models"] if m["available"]]
if not candidates:
    raise RuntimeError("No free available models support JSON schema right now")

chosen = candidates[0]
connector = chosen["routing"]["connector"]
model     = chosen["routing"]["model"]
```

### Step 3 — Execute the workload

Use `routing.connector` and `routing.model` from the catalog response directly:

```python
result = httpx.post(
    f"https://model-connector.arcanada.ai/connectors/{connector}/execute",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "prompt": "Classify this email as spam or not spam. Return JSON.",
        "model": model,
        "output_format": "json",
        "schema": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "enum": ["spam", "not_spam"]},
                "confidence": {"type": "number"}
            },
            "required": ["label", "confidence"]
        }
    },
)
```

### Why this pattern matters for low-reasoning / watching / email-checking agents

These workloads run at high frequency (polling inboxes, monitoring feeds,
classifying short texts) and have straightforward requirements: structured
output and zero cost. Hard-coding `connector: "openmodel"` works today but
breaks silently if:

- The free-tier model changes (e.g. a new `deepseek-v5-flash` replaces `v4`).
- A second connector offers a free model with better latency.
- The connector goes unhealthy and `available` drops to `false`.

By querying the catalog at startup (or periodically), the agent adapts
automatically without a code deploy.

---

## Notes

- The catalog is generated on every request — it reflects the current
  registration state of the connector registry and live health from
  `getStatus()`. It is not cached; call it as infrequently as your
  routing logic allows.
- `generatedAt` lets the consumer record when it last refreshed its local
  routing table.
- The route `/connectors/catalog` is registered before the parameterized
  `/connectors/:name/status` route to ensure the literal segment `catalog`
  is not captured as a connector name.
