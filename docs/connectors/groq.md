# Groq Connector

API connector for [Groq Cloud](https://console.groq.com/) — ultra-fast LPU-backed inference for open-weight models. Added 2026-04-27.

## Overview

| Field | Value |
|-------|-------|
| **Name** | `groq` |
| **Type** | `api` (HTTP) |
| **Base URL** | `https://api.groq.com/openai/v1/chat/completions` |
| **Auth** | `Bearer $GROQ_API_KEY` |
| **Default model** | `llama-3.3-70b-versatile` |
| **Default concurrency** | 10 (`GROQ_MAX_CONCURRENCY`) |
| **Default timeout** | 120 000 ms (`GROQ_TIMEOUT_MS`) |

## Capabilities

- ✅ JSON Schema (strict)
- ✅ JSON object
- ✅ Tool use
- ❌ Streaming (not surfaced by MC)

## Models

> **Dynamic (CONN-0236).** The list below is the static **offline/CI fallback**.
> At boot the connector fetches `GET https://api.groq.com/openai/v1/models` and
> merges the live chat models over it. Groq's listing also returns STT (whisper),
> TTS (orpheus) and moderation (prompt-guard) families — these are filtered out so
> only chat models surface here. See `docs/how-to/catalog-endpoint.md` §
> "Model-list source".

| Model | Notes |
|-------|-------|
| `llama-3.3-70b-versatile` | Default — balanced 70B |
| `llama-3.1-8b-instant` | Fastest, smallest — for high-throughput classification |
| `meta-llama/llama-4-scout-17b-16e-instruct` | Llama 4 Scout (MoE) |
| `openai/gpt-oss-120b` | OpenAI open-weight 120B |
| `openai/gpt-oss-20b` | OpenAI open-weight 20B |
| `openai/gpt-oss-safeguard-20b` | Safety-tuned 20B variant |
| `qwen/qwen3-32b` | Qwen 3 |
| `groq/compound` | Groq's tool-using compound model |
| `groq/compound-mini` | Smaller compound variant |

## Environment

```bash
GROQ_API_KEY=gsk_...          # Required — https://console.groq.com/keys
GROQ_TIMEOUT_MS=120000        # Optional
GROQ_MAX_CONCURRENCY=10       # Optional
```

## Examples

### Free-tier classification (sub-second)

```bash
curl -X POST https://connector.arcanada.one/connectors/groq/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Classify sentiment: The deploy finally went green!",
    "model": "llama-3.1-8b-instant",
    "systemPrompt": "Reply with one word: positive, negative, neutral."
  }'
```

### Structured JSON

```bash
curl -X POST https://connector.arcanada.one/connectors/groq/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{
    "prompt": "Extract entities: Pavel deploys MC to PROD on Mondays.",
    "model": "openai/gpt-oss-120b",
    "responseFormat": { "type": "json_object" }
  }'
```

## Free Tier

- 28 800 minutes / day
- 7 200 requests / day
- Rate-limit per minute varies per model (see Groq console)

Sufficient for almost any Arcanada-scale ecosystem workload. Treat as default for cheap NLU.

## Error Classification

- HTTP 401/403 → `auth_error`
- HTTP 429 → `rate_limited` (often per-minute, retry with `wait`)
- HTTP 5xx → `server_error`

## When to Use

- ✅ High-throughput classification, NLU, parsing — fastest free option in ecosystem.
- ✅ Structured output for Graphiti / Cognee / LangChain pipelines.
- ✅ Llama / Qwen / OpenAI OSS access without per-token charges.
- ❌ Anthropic Claude → use `openrouter` or `claude-code`.
- ❌ Reasoning-heavy chain-of-thought → consider `grok-4-fast-reasoning`.

## Source

- Connector: `src/connectors/groq/groq.connector.ts`
- Tests: `src/connectors/groq/groq.connector.spec.ts`
