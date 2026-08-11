# Reference: OpenAI-Compatible `/v1` Surface

The Model Connector exposes an OpenAI-compatible facade with transparent free-first
cross-provider failover (CONN-0243). This reference documents the exact request and
response shapes.

## Authentication

All `/v1` routes require `Authorization: Bearer <MC_API_KEY>` (the standard OpenAI
header). The key is validated by the global auth guard; an invalid or missing key
returns `401`.

## `POST /v1/chat/completions`

### Request body

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | Routing **preference** (see how-to). `"auto"` for the pure free-first chain. |
| `messages` | array | yes | OpenAI messages. `role ∈ {system,user,assistant,tool,developer,function}`. `content` is a string or an array of content parts (`{type,text}`); text parts are concatenated. |
| `temperature` | number 0–2 | no | Forwarded to the provider via `extra`. |
| `top_p` | number 0–1 | no | Forwarded via `extra`. |
| `max_tokens` | int > 0 | no | Forwarded via `extra`. |
| `response_format` | object | no | `{"type":"json_object"}` maps to the connector JSON mode. |
| `stream` | boolean | no | `true` → `400` (not supported yet). |
| `tools` / `tool_choice` | — | no | Present → `400` (not supported yet). |

Unknown OpenAI fields are accepted and ignored (the schema is tolerant).

Message mapping: `system` messages become the connector `systemPrompt`; a single
non-system turn becomes the `prompt`; multiple turns become a role-labelled transcript.

### Success response (`200`)

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "deepseek-v4-flash",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18 }
}
```

- `model` reflects the provider/model that actually served the request (may differ from
  the requested model after failover).
- `usage` uses OpenAI snake_case names. The internal `costUsd` is intentionally omitted.
- `finish_reason` is always `"stop"` for successful completions.

### Error responses

All errors use the OpenAI error envelope `{ "error": { "message", "type", "code" } }`.

| Status | `type` | Cause |
|--------|--------|-------|
| `400` | `unsupported` | `stream:true` or `tools`/`tool_choice` present. |
| `400` | validation message | Body failed schema validation. |
| `429` | `rate_limited` | A single addressed model returned 429 and no failover applied. |
| `503` | `cascade_exhausted` | Every failover candidate failed (rate-limited/errored). The message lists what was tried. |
| `502` | provider error type | An upstream provider error not otherwise mapped. |

### Failover semantics

On `429` / `5xx` / connection error / open circuit from a candidate, MC advances to the
next free-first candidate. DeepSeek is the default first hop. Candidates are drawn only
from models the registered connectors declare in their capabilities (anti-fabrication);
live availability is enforced by the loop itself. See
[FAILOVER_* tuning](../how-to/openai-compatible-failover.md#tuning).

## `GET /v1/models`

Returns the chat models MC can route to, in OpenAI list shape. Built from in-memory
connector capabilities (no network probes); chat models only; deduped by id.

```json
{
  "object": "list",
  "data": [
    { "id": "deepseek-v4-flash", "object": "model", "created": 1700000000, "owned_by": "openmodel" }
  ]
}
```

## Related

- How-to: [Point an OpenAI client at MC](../how-to/openai-compatible-failover.md)
- How-to: [Low-reasoning cascade profile](../how-to/low-reasoning-cascade.md)
- Reference: [Catalog endpoint](../how-to/catalog-endpoint.md)
