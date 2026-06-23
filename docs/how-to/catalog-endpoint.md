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
| `modality`   | enum   | Return only models of the given modality. Accepted values: `chat`, `embedding`, `image_generation`, `speech_to_text`, `text_to_speech`, `video`, `moderation`, `rerank` (`video` + `moderation` added in CONN-0238). |
| `type`       | enum   | Alias for `modality` (same accepted values). When both are given, `modality` wins. |
| `connector`  | string | Return only models served by that connector (exact match on the `connector` field), e.g. `groq`, `vertex`, `deepgram-stt`. |
| `tag`        | string | Exact-match a single derived tag, e.g. `cost:free`, `cap:tools`, `modality:chat`. |
| `group`      | string | Namespace-prefix match: `group=cost` returns any model carrying a `cost:*` tag. Delimiter-safe — `group=cost` never matches a `cost-something:` tag. |

Filters compose by AND: `?free=true&capability=supportsJsonSchema` returns only
free models that also support JSON schema output;
`?modality=image_generation&connector=vertex` returns only Vertex image models.

---

## Response Schema

```json
{
  "models": [
    {
      "connector": "openmodel",
      "model": "deepseek-v4-flash",
      "modality": "chat",
      "tags": ["modality:chat", "cost:free", "cost:cheap", "cap:json-schema"],
      "free": true,
      "cheap": true,
      "priceMultiplier": 0,
      "pricing": null,
      "contextWindow": null,
      "maxOutputTokens": null,
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

A connector whose provider publishes per-token pricing + context (groq,
openrouter) carries real `pricing`/`contextWindow`/`maxOutputTokens` (CONN-0238):

```json
{
  "connector": "groq",
  "model": "llama-3.3-70b-versatile",
  "modality": "chat",
  "free": true,
  "cheap": true,
  "priceMultiplier": null,
  "pricing": { "inputPerMTok": 0.59, "outputPerMTok": 0.79, "unit": "per_1m_tokens" },
  "contextWindow": 131072,
  "maxOutputTokens": 32768,
  "rateLimits": null,
  "capabilities": { "supportsStreaming": false, "supportsJsonSchema": true, "supportsTools": true },
  "routing": { "connector": "groq", "model": "llama-3.3-70b-versatile" },
  "available": true
}
```

A non-chat entry (image generation) additionally carries a `routing.endpoint`
so it is not misrepresented as the chat `/execute` route:

```json
{
  "connector": "vertex",
  "model": "vertex:imagen-4-fast",
  "modality": "image_generation",
  "tags": ["modality:image_generation"],
  "free": false,
  "cheap": false,
  "priceMultiplier": null,
  "rateLimits": null,
  "capabilities": { "supportsStreaming": false, "supportsJsonSchema": false, "supportsTools": false },
  "routing": { "connector": "vertex", "model": "vertex:imagen-4-fast", "endpoint": "/images/generate" },
  "available": true
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `connector` | `string` | Connector name (matches the `connector` field in `/execute` requests). |
| `model` | `string` | Model identifier passed as `model` in execute requests. |
| `modality` | enum | Model family: `chat`, `embedding`, `image_generation`, `speech_to_text`, `text_to_speech`, `video`, `moderation`, or `rerank` (`video` + `moderation` added in CONN-0238). Distinct from the connector's transport `type` (`cli`/`api`). One connector can now span modalities (groq: chat + STT + TTS + moderation; grok: chat + image + video). |
| `tags` | `string[]` | Derived, namespaced tags (CONN-0232). Reproducible from the other fields — never fabricated. Namespaces: `modality:`, `cost:` (`cost:free`, `cost:cheap`), `cap:` (`cap:streaming`, `cap:tools`, `cap:json-schema`). No measured/curated tags yet. |
| `free` | `boolean` | `true` when the model is on the connector's free tier (per-model since CONN-0238 — e.g. groq chat/moderation are free, its STT/TTS are not). |
| `cheap` | `boolean` | `true` when `free === true` **or** when the price multiplier is `<= 1`. |
| `priceMultiplier` | `number \| null` | Relative cost unit (openmodel catalogue). `0` = free, `1` = standard, `null` = unknown. Independent of `pricing` below. |
| `pricing` | `object \| null` | CONN-0238 — real pricing from the provider's live `/models` API: `{ inputPerMTok, outputPerMTok, unit: "per_1m_tokens" }`, normalised to USD per 1M tokens. Either field may be `null`. The whole object is `null` when the provider publishes no machine price (openmodel/grok, groq compound systems) or for non-token families (STT $/hour, TTS $/char — left null rather than mislabelled). Never invented. |
| `contextWindow` | `number \| null` | CONN-0238 — provider-published context window in tokens (groq `context_window`, openrouter `top_provider.context_length`). `null` if unknown. |
| `maxOutputTokens` | `number \| null` | CONN-0238 — provider-published max output/completion tokens. `null` if unknown. |
| `rateLimits` | `object \| null` | `{ requestsPerMinute, tokensPerMinute }` when the connector exposes live **machine** rate-limit data. Always `null` today — groq/openrouter `/models` do **not** expose RPM/TPM, and plan-tier numbers are never scraped/guessed (CONN-0238). |
| `capabilities.supportsStreaming` | `boolean` | Whether the connector supports streaming responses. |
| `capabilities.supportsJsonSchema` | `boolean` | Whether the connector accepts a JSON schema for structured output. |
| `capabilities.supportsTools` | `boolean` | Whether the connector supports tool/function calling. |
| `routing.connector` | `string` | The connector name to use in the `/execute` or `/connectors/:name/execute` path. |
| `routing.model` | `string` | The model id to pass in the execute request body. |
| `routing.endpoint` | `string \| undefined` | Real invocation path for the **executable** non-chat rows that come from the dedicated modality catalog (`ModalityCatalogService`): `/images/generate` (image), `/v1/speech/stt` (STT), `/v1/speech/tts` (TTS). Omitted for chat/embedding/moderation (standard `/execute` path) **and** for the *informational* non-chat rows surfaced through a chat connector — see `available` below. |
| `available` | `boolean` | Per-MODEL availability (CONN-0232 R10): `true` when the connector is **reachable** AND this model's circuit breaker is not open. CONN-0238: a **non-chat family surfaced through a chat connector** (groq whisper/orpheus, grok-imagine image/video) is listed for catalog completeness but is `available: false` with **no `routing.endpoint`** — the `(connector, model)` tuple is not a real route there (the executable STT row is the dedicated `groq-stt` connector; grok-imagine has no MC route). `available:false` + the modality is the honest "route via the dedicated modality connector, not this one" signal. `chat` stays executable; `moderation` (groq prompt-guard, served via chat/completions) is executable but caps-masked. A connector whose `/health` route returns `404` while its API is alive is **not** marked offline. |
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
| **groq** | Per-model flag (CONN-0238) | Groq's chat + moderation models are free-tier (rate-limited free API); its STT (whisper) / TTS (orpheus) are priced families and are **not** flagged free. The per-model `modelMeta.free` drives `freeModels[]`. | 2026-06-23 |
| **gemini** | Curated static list | Gemini CLI uses Google AI Studio OAuth (free quota). All models in the connector are accessible via the free CLI tier. | 2026-06-22 |
| **grok** | Explicit empty list | xAI has no free tier — all models are pay-per-token (docs.x.ai/docs/pricing). | 2026-06-22 |
| **openrouter** | Dynamic API fetch (all-340) | Fetches `GET https://openrouter.ai/api/v1/models` on startup; REPLACES the cache with **all** models, flagging each free when `pricing.prompt === "0" && pricing.completion === "0"` **or** the id ends with `:free` (~26 of 340). Updated once at module init via `refreshFreeModels()`. | 2026-06-23 |
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

### Model-list source: dynamic vs curated (CONN-0236, REPLACE since CONN-0238)

Each chat connector's `models[]` is populated either by a **dynamic** fetch of the
provider's own `/models` listing at boot, or by a **curated** static list. Dynamic
connectors call `refreshModels()` once from `OnModuleInit` (fire-and-forget, like
OpenRouter's refresh): they fetch `{baseUrl}/models`, parse the per-model metadata
(id + modality + pricing/context), and — **since CONN-0238 — REPLACE** the static
list with the live list rather than merging (`static ∪ provider`). The merge was a
defect: stale/phantom static ids survived a successful refresh (grok prod showed 18
= 9 real + 9 phantom; openmodel 36 = 34 real + 2 dead). REPLACE makes the live
provider list the sole source of truth, so a phantom static id cannot leak.

The static list is still the offline/CI fallback — CI makes **no live provider
call** (every test mocks `fetch` against a captured fixture), and any boot-time
failure (unreachable, non-2xx, missing API key) leaves the static list in place. The
static floors are trimmed to verified-minimum so even the offline catalog is
phantom-free.

| Connector | Model-list source | Endpoint | Static fallback | Live list (REPLACE) |
|-----------|-------------------|----------|-----------------|---------------------|
| **openmodel** | **Dynamic** | `https://api.openmodel.ai/v1/models` | 1 (`deepseek-v4-flash`) | **34** (operator-verified 2026-06-23). Dead `deepseek-r2`/`qwen3-235b` dropped. |
| **groq** | **Dynamic** | `https://api.groq.com/openai/v1/models` | 9 chat | **17, all modalities** — chat (11) + STT whisper (2) + TTS orpheus (2) + moderation prompt-guard (2), each with its real modality + pricing/context. CONN-0238 SHOWS them (CONN-0236 dropped the non-chat families). |
| **grok** | **Dynamic** | `https://api.x.ai/v1/models` | 9 (real, with modality) | **9** — chat (5) + image_generation grok-imagine-image (2) + video grok-imagine-video (2). Real ids replace the CONN-0236 phantom list. No pricing in xAI `/v1/models`. |
| **openrouter** | **Dynamic** | `https://openrouter.ai/api/v1/models` | 6 paid | **all ~340** (26 free) — REPLACE surfaces every model with a per-model `free` flag + pricing + context; the page defaults to free-first via `?free=true`. CONN-0236 surfaced free-only. |
| **gemini** | **Curated, dated** | — (CLI connector, Google API shape) | 3 | Not OpenAI-compatible; kept curated rather than forcing an OpenAI-shape fetch. |
| **claude-code, codex, cursor** | **Curated, dated** | — (CLI connectors) | per connector | Account/subscription-scoped; no public `/models` listing to fetch. |

**Anti-fabrication:** every dynamically-fetched id comes from a live provider
response (groq/openrouter are live captures; grok/openmodel are operator live
captures 2026-06-23), and every static-fallback id is cited and dated. No model id
or price is invented — pricing/context are surfaced verbatim from the `/models`
response. The capture fixtures and their provenance live in
`test/fixtures/connectors/README.md`.

### Modality coverage & completeness (CONN-0232)

The catalog spans **all** model families MC serves, not just chat:

| Modality | Source | Connectors / models |
|----------|--------|---------------------|
| `chat` | registered chat connectors | claude-code, codex, cursor, gemini (curated); grok, groq, openmodel, openrouter (dynamic — see "Model-list source" above) |
| `embedding` | registered connector | embedding (`bge-m3`) |
| `image_generation` | curated `IMAGE_CAPABILITIES` + chat-connector listings (CONN-0238) | vertex (4), replicate (1), openai-images (3), fal-ai (2); grok-imagine-image (informational, `available:false`) |
| `speech_to_text` | each STT connector's own default model + chat-connector listings (CONN-0238) | assemblyai-stt, deepgram-stt, groq-stt, local-whisper, openai-stt; groq whisper (informational, `available:false`) |
| `text_to_speech` | proxy routing entry + chat-connector listings (CONN-0238) | `tts` → Transcribator (`/v1/speech/tts`); groq orpheus (informational, `available:false`) |
| `video` | chat-connector listings (CONN-0238) | grok-imagine-video (informational, `available:false` — no MC video execute route yet) |
| `moderation` | chat-connector listings (CONN-0238) | groq llama-prompt-guard (executable via chat/completions) |
| `rerank` | reserved | no connector yet → **zero entries** (the enum value exists so a future connector needs no breaking change) |

Image-generation, STT and TTS connectors do not implement the chat `IConnector`
contract, so they are surfaced via a dedicated static modality catalog rather
than the chat connector registry. **Anti-fabrication:** every static model id is
sourced — image models from the dated `IMAGE_CAPABILITIES` map, STT models from
each connector's own hard-coded default — and the catalog makes **no live
provider call**. No id is invented.

### Connector reachability vs per-model availability (CONN-0232 R10)

`available` is computed **per model**. A connector is considered *reachable* when
a probe of its health route returns any non-5xx status — a `404` ("no such
route", e.g. a provider that does not serve `/health`) or `401`/`403`
("API alive, auth required") all count as reachable; only `5xx`, timeouts and
network/DNS failures count as down. A model is then `available` only when its
connector is reachable **and** the model's own circuit breaker is not open, so a
single failing model no longer marks its siblings — or a whole connector with a
missing `/health` route — offline.

### Pricing & context (CONN-0238)

`pricing`, `contextWindow` and `maxOutputTokens` are surfaced from the provider's
live `/models` API where it publishes them:

- **groq** `/models` carries per-token `pricing` (`prompt`/`completion`),
  `context_window` and `max_completion_tokens`. Token prices are normalised to USD
  per 1M tokens (`unit: "per_1m_tokens"`). STT/TTS keep `pricing: null` (their
  $/hour & $/char are not MTok-comparable — never mislabelled).
- **openrouter** `/models` carries per-token `pricing` plus
  `top_provider.context_length`/`max_completion_tokens`.
- **openmodel / grok** `/models` expose no machine per-token price → `pricing: null`
  (openmodel still has the relative `priceMultiplier` from its catalogue).

Every number is taken verbatim from the live response — none is invented.

### Rate limits

No connector exposes live **machine** RPM/TPM data to the Model Connector API —
groq and openrouter publish RPM/TPM only on their docs pages, and those are
plan-tier-dependent. Per the never-invent rule, `rateLimits` is therefore `null`
for every model: plan-tier numbers are **not** scraped or guessed. The field will
be populated only from a machine source (an API field or `x-ratelimit-*` response
headers) when a connector exposes one — as `{ requestsPerMinute: N,
tokensPerMinute: M }` (either may be `null` if only one dimension is known).

---

## Error responses

| HTTP status | `error` field | Cause |
|-------------|--------------|-------|
| `400` | `validation_error` | An unknown `capability` value (e.g. `supportsUnicorns`) or an unknown `modality`/`type` value (e.g. `telepathy`) was passed. |
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
