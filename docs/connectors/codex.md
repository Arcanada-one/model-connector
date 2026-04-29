# Codex (OpenAI) Connector

CLI connector for the [`codex`](https://platform.openai.com/docs/codex) binary — OpenAI's reasoning-tuned CLI agent. Outputs JSONL (event stream) instead of single JSON.

## Overview

| Field | Value |
|-------|-------|
| **Name** | `codex` |
| **Type** | `cli` |
| **Binary** | `codex` |
| **Auth** | OpenAI OAuth (chatgpt.com) or `OPENAI_API_KEY` |
| **Default model** | `o4-mini` |
| **Default concurrency** | 4 (uses generic `CONNECTOR_MAX_CONCURRENCY` fallback unless set) |
| **Default timeout** | 600 000 ms |

> ⚠ Currently **local Mac only** — not yet deployed to PROD Docker.

## Capabilities

- ❌ JSON Schema (CLI flag `--output-schema` exists but not surfaced via `responseFormat` in MC yet — tracked in CONN-0044 / CONN-0045)
- ⚠️ JSON object (prompt-injected)
- ✅ Tool use
- ✅ JSONL streaming output (parsed and consolidated by connector)

## Models

| Model | Notes |
|-------|-------|
| `o4-mini` | Default — fast reasoning |
| `o3` | Heavier reasoning (slower, OAuth tier-dependent) |
| `codex-mini-latest` | Codex-specialized variant |

## CLI Flags

The connector spawns Codex with:
```
--full-auto --ephemeral --skip-git-repo-check
```

## Environment

```bash
OPENAI_API_KEY=sk-...    # Optional — OAuth via chatgpt.com is default
```

## Example (local)

```bash
curl -X POST http://localhost:3900/connectors/codex/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -d '{"prompt": "Solve: integral of x^2 dx", "model": "o4-mini"}'
```

## JSONL Output Parsing

Codex emits one event per line. The connector:
1. Collects all event lines.
2. Extracts `message.completed` (final text) and `turn.completed` (usage stats).
3. If only stderr is present (binary error / not logged in), surfaces stderr through `extractStderrError()` and classifies (CONN-0046 fix).

Common stderr classifications:

| Stderr fragment | Classified as |
|-----------------|---------------|
| `Not logged in` | `auth_error` |
| `output schema ... not valid json` | `validation_error` |
| (any other non-empty) | `execution_error` |

## When to Use

- ✅ Reasoning workloads (`o3`, `o4-mini`) when you need OpenAI's reasoning models.
- ✅ Local Mac development — no Docker dependency yet.
- ❌ PROD workloads — not deployed yet.
- ❌ High-throughput — CLI overhead.

## Limitations / Known Issues

1. Not yet in PROD Docker compose (no `~/.codex/` volume).
2. `--output-schema` not exposed via MC `responseFormat`. Use `extra.codexFlags` workaround if needed.
3. CONN-0044 capability report identified API-tier model availability gap — re-verify `o4-mini` access on your account tier.

## Source

- Connector: `src/connectors/codex/codex.connector.ts`
- Tests: `src/connectors/codex/codex.connector.spec.ts`
- Capability report: `documentation/archive/connectors/archive-CONN-0044.md` (workspace)
