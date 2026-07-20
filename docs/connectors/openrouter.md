# OpenRouter Connector

API connector for [OpenRouter](https://openrouter.ai/) — unified access to 200+ models across providers (Anthropic, OpenAI, Google, Meta, Mistral, etc.).

## Overview

| Field | Value |
|-------|-------|
| **Name** | `openrouter` |
| **Type** | `api` (HTTP) |
| **Base URL** | `https://openrouter.ai/api/v1/chat/completions` |
| **Auth** | `Bearer $OPENROUTER_API_KEY` |
| **Default model** | none — caller MUST specify `model` |
| **Default concurrency** | 10 (`OPENROUTER_MAX_CONCURRENCY`) |
| **Default timeout** | 120 000 ms (`OPENROUTER_TIMEOUT_MS`) |

## Capabilities

- ✅ JSON Schema (strict, when underlying provider supports it)
- ✅ JSON object
- ✅ Tool use
- ❌ Streaming (not surfaced by MC)

## Recommended Models

OpenRouter routes to the actual provider — pricing/latency depend on the chosen model.

| Use case | Model | Latency | Cost |
|----------|-------|---------|------|
| NLU, classification | `meta-llama/llama-4-maverick` | ~0.5s | free tier |
| Generation (quality) | `anthropic/claude-sonnet-4` | ~1s | $3 / 1M in |
| Cheap generation | `openai/gpt-4o-mini` | ~0.5s | $0.15 / 1M in |
| Top-tier generation | `anthropic/claude-opus-4` | ~2s | $15 / 1M in |
| Open-weight large | `meta-llama/llama-3.1-405b-instruct` | ~1–2s | per provider |

Full catalogue: https://openrouter.ai/models

## Environment

```bash
OPENROUTER_API_KEY=sk-or-v1-...   # Required
OPENROUTER_TIMEOUT_MS=120000      # Optional
OPENROUTER_MAX_CONCURRENCY=10     # Optional
```

## Examples

### Generic call

```bash
curl -X POST https://connector.arcanada.ai/connectors/openrouter/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{
    "prompt": "Summarize this article in 3 bullets",
    "model": "anthropic/claude-sonnet-4"
  }'
```

### Structured output for Graphiti / Cognee

```bash
curl -X POST https://connector.arcanada.ai/connectors/openrouter/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{
    "prompt": "Extract entities and relations: ...",
    "model": "openai/gpt-4o-mini",
    "responseFormat": { "type": "json_object" },
    "extra": { "temperature": 0, "max_tokens": 2000 }
  }'
```

### `extra` options

- `max_tokens` — max tokens in response
- `temperature` — sampling temperature (0–2)
- `top_p` — nucleus sampling

## When to Use

- ✅ **Default choice** for any LLM workload that needs Claude or GPT-4 class quality.
- ✅ Drop-in OpenAI-compatible endpoint for Graphiti, Cognee, LangChain agents.
- ✅ Multi-provider fallback (route through different models without code change).
- ❌ When you want free Llama / Qwen — use `groq` (faster, free tier).
- ❌ Embeddings → use `embedding`.

## Source

- Connector: `src/connectors/openrouter/openrouter.connector.ts`
- Tests: `src/connectors/openrouter/openrouter.connector.spec.ts`
