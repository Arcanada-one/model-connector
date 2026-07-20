# Claude Code Connector

CLI connector for the official [Claude Code](https://docs.claude.com/en/docs/claude-code) binary. Wraps the `claude` CLI with subprocess spawning, JSON output parsing, and Anthropic-tier features (tools, thinking, schema validation).

## Overview

| Field | Value |
|-------|-------|
| **Name** | `claude-code` |
| **Type** | `cli` |
| **Binary** | `claude` (override: `CLAUDE_BINARY_PATH`) |
| **Auth** | Subscription (Max plan) — credentials in Docker volume `claude-auth` (`~/.claude/`) |
| **Default model** | `sonnet` |
| **Default concurrency** | 4 (`CLAUDE_CODE_MAX_CONCURRENCY`) |
| **Default timeout** | 600 000 ms (10 min) |

## Capabilities

- ✅ JSON Schema (strict via `--json-schema`)
- ✅ JSON object (system-prompt injection)
- ✅ Tool use (built-in: `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, plus MCP servers)
- ✅ Thinking mode
- ✅ Permission modes (`bypassPermissions`, `plan`, etc.)

## Models

| Model | Notes |
|-------|-------|
| `sonnet` / `claude-sonnet-4-6` | Default — balanced quality/cost |
| `opus` / `claude-opus-4-6` | Top-tier reasoning |
| `haiku` / `claude-haiku-4-5` | Fast / cheap |

## Environment

```bash
CLAUDE_BINARY_PATH=claude          # Path to binary
CLAUDE_CODE_MAX_CONCURRENCY=4      # Concurrent CLI processes
```

## `extra` Options

- `permissionMode` — `"bypassPermissions"` (default), `"plan"`, etc.
- `allowedTools` / `disallowedTools` — comma-separated tool names
- `fallbackModel` — fallback model on primary failure
- `thinking` — `"enabled"` / `"disabled"`
- `addDir` — additional directory context

## Examples

### Simple Q&A

```bash
curl -X POST https://connector.arcanada.ai/connectors/claude-code/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{"prompt": "What is 2+2?", "maxTurns": 1}'
```

### Code task with file access

```bash
curl -X POST https://connector.arcanada.ai/connectors/claude-code/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{
    "prompt": "Read README.md and summarize the install steps.",
    "model": "sonnet",
    "maxTurns": 10,
    "extra": { "addDir": "/workspace/myproject" }
  }'
```

### Structured output (json_schema)

```bash
curl -X POST https://connector.arcanada.ai/connectors/claude-code/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{
    "prompt": "Extract: Pavel, age 42, works on Arcanada",
    "jsonSchema": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "age": {"type": "number"},
        "project": {"type": "string"}
      },
      "required": ["name", "age", "project"]
    }
  }'
```

## Re-Auth

```bash
ssh root@65.108.236.39
docker exec code-model-connector-1 claude -p "ping" --output-format json --max-turns 1
# If "Not logged in":
docker exec -it code-model-connector-1 claude
# Run /login
```

## When to Use

- ✅ Code/file-access workflows (best built-in tool integration).
- ✅ When you need Claude quality + native MCP server support.
- ✅ Long-running agent loops (max timeout 10 min).
- ❌ Cheap classification — use `groq` or `openrouter`.
- ❌ Embeddings — use `embedding`.

## Source

- Connector: `src/connectors/claude-code/claude-code.connector.ts`
- Tests: `src/connectors/claude-code/claude-code.connector.spec.ts`
