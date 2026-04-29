# Grok (xAI) Connector

API connector for [xAI's Grok](https://docs.x.ai/) family. Added 2026-04-29 (CONN-0048).

## Overview

| Field | Value |
|-------|-------|
| **Name** | `grok` |
| **Type** | `api` (HTTP) |
| **Base URL** | `https://api.x.ai/v1/chat/completions` |
| **Auth** | `Bearer $XAI_API_KEY` |
| **Default model** | `grok-4-fast` |
| **Default concurrency** | 10 (`GROK_MAX_CONCURRENCY`) |
| **Default timeout** | 120 000 ms (`GROK_TIMEOUT_MS`) |

## Capabilities

- ✅ JSON Schema (strict) — `responseFormat: { type: "json_schema", json_schema: {...} }`
- ✅ JSON object — `responseFormat: { type: "json_object" }`
- ✅ Tool use (function calling)
- ❌ Streaming (not surfaced by MC)

## Models

| Model | Use case |
|-------|----------|
| `grok-4-fast` | Default — balanced speed/quality |
| `grok-4-fast-reasoning` | Reasoning-heavy tasks (math, planning) |
| `grok-4-fast-non-reasoning` | Pure text generation, lower latency |
| `grok-4-1-fast-reasoning` | Newer reasoning (4.1 line) |
| `grok-4-1-fast-non-reasoning` | Newer text gen (4.1 line) |
| `grok-4-0709` | Pinned 4.0 build (snapshot) |
| `grok-3` | Previous-gen flagship |
| `grok-3-mini` | Cheaper, smaller context |
| `grok-code-fast-1` | Code-specialized variant |

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
    "model": "grok-4-fast"
  }'
```

### Reasoning model

```bash
curl -X POST https://connector.arcanada.one/connectors/grok/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "If 7 workers paint 3 walls in 5 hours, how long for 21 workers and 30 walls?",
    "model": "grok-4-fast-reasoning"
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

- ✅ Reasoning workloads (`grok-4-fast-reasoning`, `grok-4-1-fast-reasoning`).
- ✅ Code-related tasks where `grok-code-fast-1` outperforms general models.
- ✅ Structured output (json_schema strict).
- ❌ Embeddings → use `embedding` connector.
- ❌ File-system / code-execution agent flows → use `claude-code`.

## Source

- Connector: `src/connectors/grok/grok.connector.ts`
- Module: `src/connectors/grok/grok.module.ts`
- Tests: `src/connectors/grok/grok.connector.spec.ts`
- Archive: `documentation/archive/connectors/archive-CONN-0048.md` (workspace)
