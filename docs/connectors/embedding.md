# Embedding Connector

API connector for the self-hosted **BGE-M3** embedding service running on Arcanada DB server (`arcana-db:8300`). Free, fast, no rate limits.

## Overview

| Field | Value |
|-------|-------|
| **Name** | `embedding` |
| **Type** | `api` (HTTP) |
| **Base URL** | `http://arcana-db:8300` (internal, Tailscale-only) |
| **Auth** | None (Tailscale network ACL) |
| **Default model** | `bge-m3` |
| **Default concurrency** | 8 (`EMBEDDING_MAX_CONCURRENCY`) |
| **Default timeout** | 30 000 ms (`EMBEDDING_TIMEOUT_MS`) |

## Capabilities

- ❌ JSON Schema (n/a — embeddings, not LLM)
- ❌ Tool use (n/a)
- ✅ 4 modes: dense, sparse, ColBERT, hybrid

## Models

| Model | Notes |
|-------|-------|
| `bge-m3` | Multilingual embedding model — dense (1024-dim), sparse, ColBERT vectors |

## `extra` Options

- `embeddingType` — `"dense"` (default), `"sparse"`, `"colbert"`, `"hybrid"`

## Examples

### Dense embedding (default)

```bash
curl -X POST https://connector.arcanada.one/connectors/embedding/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{"prompt": "Pavel founded Arcanada in 2026"}'
```

Response includes vector in `result` / `structured` (1024 floats).

### Hybrid (dense + sparse + ColBERT)

```bash
curl -X POST https://connector.arcanada.one/connectors/embedding/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{
    "prompt": "your text",
    "extra": { "embeddingType": "hybrid" }
  }'
```

Returns all three vector representations — used by Scrutator hybrid search.

## When to Use

- ✅ **Default for any embedding workload** in the ecosystem.
- ✅ Scrutator chunk indexing, similarity search, RAG pipelines.
- ✅ LTM (Long Term Memory) embedding generation.
- ❌ Text generation — use any LLM connector.

## Operational Notes

- Self-hosted on `arcana-db:8300` — bypass Cloudflare entirely (use Tailscale IP `100.121.155.54:3900` for MC, or call MC directly which routes internally).
- Free — no quota, no per-token cost.
- Latency ~0.2s for short text, scales linearly with token count.

## Source

- Connector: `src/connectors/embedding/embedding.connector.ts`
- Tests: `src/connectors/embedding/embedding.connector.spec.ts`
- Embedding service: `Projects/Scrutator/code/embedding-api/` (workspace, separate repo)
