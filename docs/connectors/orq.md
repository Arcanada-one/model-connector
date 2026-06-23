# orq.ai Connector

API connector for [orq.ai](https://my.orq.ai/) — OpenAI-compatible LLM gateway
proxying 31+ vendors and 500+ models (chat, image, TTS, STT, embedding, rerank)
behind a single `sk-orq-...` Bearer key. Added 2026-06-23 (CONN-0239).

## Overview

| Field | Value |
|-------|-------|
| **Name** | `orq` |
| **Type** | `api` (HTTP) |
| **Base URL** | `https://api.orq.ai/v2` |
| **Chat endpoint** | `POST /v2/proxy/chat/completions` |
| **Discovery endpoint** | `GET /v2/models` (top-level JSON array) |
| **Auth** | `Bearer $ORQ_API_KEY` |
| **Default model** | `gpt-4o-mini` |
| **Default concurrency** | 10 (`ORQ_MAX_CONCURRENCY`) |
| **Default timeout** | 120 000 ms (`ORQ_TIMEOUT_MS`) |

## Capabilities

- ✅ JSON object
- ✅ Tool use
- ✅ Structured output (via `responseFormat.type = 'json_object'`)
- ❌ Streaming (not surfaced by MC)

## Models

orq.ai exposes ~421 chat-active models from providers such as OpenAI, Anthropic,
DeepSeek, Groq, Mistral, and others. The connector discovers them dynamically at
boot via `GET /v2/models`, filtering for `model_type === 'chat' && is_active === true`.

Non-chat modalities (image / TTS / STT / embedding / rerank) are out of scope for
this chat connector.

Static seed (boot fallback when `/v2/models` is unreachable):
- `gpt-4o-mini`
- `gpt-4o`
- `deepseek-ai/DeepSeek-R1`

Full live model list: `GET /v2/models` filtered as above.

## Environment

```bash
ORQ_API_KEY=sk-orq-<your-key>   # Required — https://my.orq.ai/settings/api-keys
ORQ_TIMEOUT_MS=120000        # Optional
ORQ_MAX_CONCURRENCY=10       # Optional
```

## Examples

### Basic chat call

```bash
curl -X POST https://connector.arcanada.ai/connectors/orq/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Classify sentiment: The deploy finally went green!",
    "model": "gpt-4o-mini",
    "systemPrompt": "Reply with one word: positive, negative, neutral."
  }'
```

### Structured JSON

```bash
curl -X POST https://connector.arcanada.ai/connectors/orq/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Extract entities: Pavel deploys MC to PROD on Mondays.",
    "model": "deepseek-ai/DeepSeek-R1",
    "responseFormat": { "type": "json_object" }
  }'
```

### `extra` options

- `max_tokens` — max tokens in response
- `temperature` — sampling temperature (0–2)
- `top_p` — nucleus sampling

## Pricing

orq is a **paid** gateway. No free tier or per-call cost echo in the response.
`costUsd` is always `0` in MC's response — billing happens on the orq.ai dashboard.

## Error Classification

- HTTP 401/403 → `auth_error`
- HTTP 429 → `rate_limited`
- HTTP 5xx → `server_error`

## Deploy / Vault

- Vault path: `secret/connector/orq_api_key` (mirrors `secret/connector/openrouter_api_key`)
- PROD env: `ORQ_API_KEY` injected via same mechanism as `OPENROUTER_API_KEY`
- Local dev: export from `config/credentials/my.orq.ai.md` (gitignored, never committed)

## When to Use

- ✅ Access to a wide multi-vendor model catalogue under a single key.
- ✅ OpenAI-compatible API requests routed to non-OpenAI providers.
- ✅ DeepSeek / Mistral / Groq-backed models without separate provider keys.
- ❌ Free-tier inference → use `groq` or OpenRouter free models.
- ❌ Embeddings → use `embedding`.

## Source

- Connector: `src/connectors/orq/orq.connector.ts`
- Module: `src/connectors/orq/orq.module.ts`
- Tests: `src/connectors/orq/orq.connector.spec.ts`
