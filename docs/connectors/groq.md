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

> **Dynamic, REPLACE, all-modalities (CONN-0238).** The 9 chat ids below are the
> static **offline/CI fallback**. At boot the connector fetches
> `GET https://api.groq.com/openai/v1/models` and **REPLACES** the floor with the
> live **17** models. Groq's listing spans modalities: CONN-0238 SHOWS them all
> with their real modality + pricing/context (CONN-0236 dropped the non-chat
> families). Chat + moderation are executable via this connector; the STT/TTS rows
> are informational (`available:false` — the executable STT route is the dedicated
> `groq-stt` connector). See `docs/how-to/catalog-endpoint.md` § "Model-list source".

| Model | Modality | Notes |
|-------|----------|-------|
| `llama-3.3-70b-versatile` | chat | Default — balanced 70B ($0.59/$0.79 per 1M) |
| `llama-3.1-8b-instant` | chat | Fastest, smallest — high-throughput classification |
| `meta-llama/llama-4-scout-17b-16e-instruct` | chat | Llama 4 Scout (MoE, vision) |
| `openai/gpt-oss-120b` | chat | OpenAI open-weight 120B |
| `openai/gpt-oss-20b` | chat | OpenAI open-weight 20B |
| `openai/gpt-oss-safeguard-20b` | chat | Safety-tuned 20B variant |
| `qwen/qwen3-32b` | chat | Qwen 3 |
| `qwen/qwen3.6-27b` | chat | Qwen 3.6 (vision) |
| `allam-2-7b` | chat | Arabic-focused 7B |
| `groq/compound` | chat | Groq's tool-using compound model |
| `groq/compound-mini` | chat | Smaller compound variant |
| `whisper-large-v3`, `whisper-large-v3-turbo` | speech_to_text | STT (informational — call via `groq-stt`) |
| `canopylabs/orpheus-v1-english`, `canopylabs/orpheus-arabic-saudi` | text_to_speech | TTS (informational) |
| `meta-llama/llama-prompt-guard-2-22m`, `-86m` | moderation | Safety classifier (via chat/completions) |

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
