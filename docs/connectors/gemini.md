# Gemini Connector

CLI connector for the official [Gemini CLI](https://github.com/google-gemini/gemini-cli) binary. Google OAuth-backed access to `gemini-2.5-flash` family.

## Overview

| Field | Value |
|-------|-------|
| **Name** | `gemini` |
| **Type** | `cli` |
| **Binary** | `gemini` (override: `GEMINI_BINARY_PATH`) |
| **Auth** | Google OAuth — credentials in Docker volume `gemini-auth` (`~/.gemini/`) |
| **Default model** | `gemini-2.5-flash` |
| **Default concurrency** | 4 (`GEMINI_MAX_CONCURRENCY`) |
| **Default timeout** | 600 000 ms |

## Capabilities

- ❌ JSON Schema
- ⚠️ JSON object (prompt-injected)
- ✅ Tool use
- ✅ Sandbox mode (`extra.sandbox=true`)

## Models

| Model | Notes |
|-------|-------|
| `gemini-2.5-flash` | Default — fast, cheap |
| `gemini-3-flash-preview` | Newer (preview) |
| `gemini-2.5-flash-lite` | Even cheaper |

## Environment

```bash
GEMINI_BINARY_PATH=gemini
GEMINI_MAX_CONCURRENCY=4
```

## `extra` Options

- `sandbox` — `true` to enable sandboxed execution

## Example

```bash
curl -X POST https://connector.arcanada.one/connectors/gemini/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{"prompt": "Translate to French: Hello world", "model": "gemini-2.5-flash"}'
```

## Re-Auth

```bash
ssh root@65.108.236.39
docker exec -it -w /tmp code-model-connector-1 gemini
# If "Signed in with Google" → already authed (Ctrl+C)
# Otherwise → /auth in interactive mode
```

## When to Use

- ✅ Free Google quota for casual use.
- ✅ When you specifically need Gemini's capabilities.
- ❌ Latency-sensitive workloads — observed 8–22s in benchmarks.
- ❌ Structured output / Graphiti / Cognee — no `json_schema`.
- ❌ Embeddings — use `embedding` connector.

## Source

- Connector: `src/connectors/gemini/gemini.connector.ts`
- Tests: `src/connectors/gemini/gemini.connector.spec.ts`
