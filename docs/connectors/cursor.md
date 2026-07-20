# Cursor Connector

CLI connector for the [`cursor-agent`](https://cursor.com/) binary. Subscription-backed access to GPT-5, Claude 4.6, Gemini 3 via Cursor's routing.

## Overview

| Field | Value |
|-------|-------|
| **Name** | `cursor` |
| **Type** | `cli` |
| **Binary** | `cursor-agent` (override: `CURSOR_BINARY_PATH`) |
| **Auth** | Cursor subscription — tokens in OS keyring + Docker volume `cursor-auth` (`~/.cursor/`) |
| **Default model** | `auto` |
| **Default concurrency** | **1** (`CURSOR_MAX_CONCURRENCY`) — **DO NOT INCREASE** |
| **Default timeout** | 600 000 ms (10 min) |

## ⚠ Critical Limitation: Concurrency = 1

`cursor-agent` uses file-based state (`~/.cursor/cli-config.json`). Concurrent calls cause `ENOENT: rename cli-config.json.tmp` race condition, followed by **auth loss** requiring re-login.

`CURSOR_MAX_CONCURRENCY=1` is HARD — increasing it will break the connector.

## Capabilities

- ❌ JSON Schema (no native support)
- ⚠️ JSON object (prompt-injected instruction — not server-validated)
- ✅ Tool use (Cursor's workspace-aware composer tools)
- ❌ Concurrency

## Models

| Model | Notes |
|-------|-------|
| `auto` | Default — Cursor routes to best available |
| `composer-2-fast` | Cursor's fast composer model |
| `claude-4.6-opus-high` | Claude Opus via Cursor |
| `claude-4.6-sonnet-medium` | Claude Sonnet via Cursor |
| `gpt-5.4-medium` | GPT-5 via Cursor |
| `gemini-3.1-pro` | Gemini via Cursor |

Run `cursor-agent --list-models` for the live list.

## Environment

```bash
CURSOR_BINARY_PATH=cursor-agent
CURSOR_MAX_CONCURRENCY=1     # MANDATORY — do not change
```

## `extra` Options

- `mode` — `"plan"`, `"normal"`, etc.
- `workspace` — workspace directory path

## Example

```bash
curl -X POST https://connector.arcanada.ai/connectors/cursor/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{
    "prompt": "Refactor the auth handler to use async/await",
    "model": "claude-4.6-sonnet-medium",
    "extra": { "workspace": "/workspace/myproject" }
  }'
```

## Re-Auth

```bash
ssh root@65.108.236.39
docker exec code-model-connector-1 cursor-agent status
# If "Not logged in":
docker exec -it -e NO_OPEN_BROWSER=1 code-model-connector-1 cursor-agent login
```

## When to Use

- ✅ Cursor-specific workspace-aware composer flows.
- ✅ When you need Cursor's IDE-style code edits.
- ❌ Anything high-throughput — concurrency=1 is a bottleneck.
- ❌ Structured output — use API connectors.
- ❌ Default LLM workload — `openrouter` is faster and parallelizable.

## Source

- Connector: `src/connectors/cursor/cursor.connector.ts`
- Tests: `src/connectors/cursor/cursor.connector.spec.ts`
