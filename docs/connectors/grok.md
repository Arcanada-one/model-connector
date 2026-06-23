# Grok (xAI) Connector

API connector for [xAI's Grok](https://docs.x.ai/) family. Added 2026-04-29.

## Overview

| Field | Value |
|-------|-------|
| **Name** | `grok` |
| **Type** | `api` (HTTP) |
| **Base URL** | `https://api.x.ai/v1/chat/completions` |
| **Auth** | `Bearer $XAI_API_KEY` |
| **Default model** | `grok-4.3` |
| **Default concurrency** | 10 (`GROK_MAX_CONCURRENCY`) |
| **Default timeout** | 120 000 ms (`GROK_TIMEOUT_MS`) |

## Capabilities

- ✅ JSON Schema (strict) — `responseFormat: { type: "json_schema", json_schema: {...} }`
- ✅ JSON object — `responseFormat: { type: "json_object" }`
- ✅ Tool use (function calling)
- ❌ Streaming (not surfaced by MC)

## Models

> **Dynamic, REPLACE (CONN-0238).** The list below is the static **offline/CI
> fallback** (the real 9, operator live capture 2026-06-23). At boot the connector
> fetches `GET https://api.x.ai/v1/models` (where `XAI_API_KEY` is set) and
> **REPLACES** the static list with xAI's live list — no UNION, so the old phantom
> ids (`grok-4-fast`, `grok-3`, …) that the CONN-0236 merge leaked are gone. The
> connector spans modalities: chat + image (grok-imagine-image) + video
> (grok-imagine-video). See `docs/how-to/catalog-endpoint.md` § "Model-list source".

| Model | Modality | Use case |
|-------|----------|----------|
| `grok-4.3` | chat | Default — flagship |
| `grok-4.20-0309-reasoning` | chat | Reasoning-heavy tasks (math, planning) |
| `grok-4.20-0309-non-reasoning` | chat | Pure text generation, lower latency |
| `grok-4.20-multi-agent-0309` | chat | Multi-agent orchestration build |
| `grok-build-0.1` | chat | Build/agentic variant |
| `grok-imagine-image` | image_generation | Image generation (informational — not executable via this chat connector) |
| `grok-imagine-image-quality` | image_generation | High-quality image generation |
| `grok-imagine-video` | video | Video generation (no MC execute route yet) |
| `grok-imagine-video-1.5` | video | Video generation (1.5 line) |

## Environment

```bash
XAI_API_KEY=xai-...           # Required — get from https://console.x.ai/
GROK_TIMEOUT_MS=120000        # Optional — default 120s
GROK_MAX_CONCURRENCY=10       # Optional — default 10
```

## Examples

### Basic call

```bash
curl -X POST https://connector.arcanada.one/connectors/grok/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Explain transformers in one sentence",
    "model": "grok-4.3"
  }'
```

### Reasoning model

```bash
curl -X POST https://connector.arcanada.one/connectors/grok/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "If 7 workers paint 3 walls in 5 hours, how long for 21 workers and 30 walls?",
    "model": "grok-4.20-0309-reasoning"
  }'
```

### Structured output

```bash
curl -X POST https://connector.arcanada.one/connectors/grok/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Return JSON: name=Pavel, age=42",
    "responseFormat": { "type": "json_object" }
  }'
```

## Error Classification

Standard `BaseApiConnector` error mapping. Notable:

- HTTP 401/403 → `auth_error` (rotate `XAI_API_KEY`).
- HTTP 429 → `rate_limited` (xAI per-org quota).
- HTTP 5xx → `server_error` (retryable).
- Body shape mismatch → `json_parse_error`.

## When to Use

- ✅ Reasoning workloads (`grok-4.20-0309-reasoning`).
- ✅ Build/agentic tasks where `grok-build-0.1` fits.
- ✅ Structured output (json_schema strict).
- ❌ Embeddings → use `embedding` connector.
- ❌ File-system / code-execution agent flows → use `claude-code`.

## Source

- Connector: `src/connectors/grok/grok.connector.ts`
- Module: `src/connectors/grok/grok.module.ts`
- Tests: `src/connectors/grok/grok.connector.spec.ts`
