# Embedding Connector

API connector for a BGE-M3 embedding service. The endpoint must be configured explicitly; without it, embedding requests return a non-retryable `config_error` and connector health reports unhealthy without making a network request.

## Overview

| Field | Value |
|-------|-------|
| **Name** | `embedding` |
| **Type** | `api` (HTTP) |
| **Base URL** | `EMBEDDING_API_URL` (required to make requests; no default) |
| **Auth** | No connector-level auth; endpoint authentication and network controls depend on the configured service and must be provided separately when required |
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

### Local development

Run an embedding service on the same machine and set this explicit local-only URL:

```bash
EMBEDDING_API_URL=http://127.0.0.1:8300
```

Production and shared environments must set `EMBEDDING_API_URL` to their approved service endpoint explicitly. An unset or empty value leaves the connector disabled; `/health` remains a process liveness check, while `/health/connectors` reports this connector as unhealthy.

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

- Configure the endpoint explicitly for each environment. The connector does not select a shared or production endpoint when `EMBEDDING_API_URL` is unset.
- Capacity, pricing, and latency depend on the configured embedding service.

## Source

- Connector: `src/connectors/embedding/embedding.connector.ts`
- Tests: `src/connectors/embedding/embedding.connector.spec.ts`
- Embedding service: `Projects/Scrutator/code/embedding-api/` (workspace, separate repo)
