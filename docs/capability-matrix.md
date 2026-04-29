# Connector Capability Matrix

Single-glance comparison of all Model Connector backends. Use this to pick the right connector for a workload.

> Last updated: 2026-04-29 (CONN-0048 — Grok added)

## Capability Table

| Connector | Type | Default Model | json_schema | json_object | tools | Concurrency | Auth | Avg Latency | Cost |
|-----------|------|---------------|:-----------:|:-----------:|:-----:|:-----------:|------|-------------|------|
| `claude-code` | CLI | `sonnet` | ✅ | ✅ | ✅ | 4 | Subscription (Max plan) | ~4s | subscription |
| `cursor` | CLI | `auto` | ❌ | ⚠️ prompt | ✅ | **1** | Subscription | ~10s | subscription |
| `gemini` | CLI | `gemini-2.5-flash` | ❌ | ⚠️ prompt | ✅ | 4 | Google OAuth | ~8–22s | free tier |
| `codex` | CLI | `o4-mini` | ❌¹ | ⚠️ prompt | ✅ | 4 | OpenAI OAuth or `OPENAI_API_KEY` | ~6–12s | ChatGPT-tier |
| `openrouter` | API | (no default — caller must set) | ✅ | ✅ | ✅ | 10 | `OPENROUTER_API_KEY` | ~0.5–1s | per-model |
| `groq` | API | `llama-3.3-70b-versatile` | ✅ | ✅ | ✅ | 10 | `GROQ_API_KEY` | ~0.15–0.7s | free tier (28.8K min/day) |
| `grok` | API | `grok-4-fast` | ✅ | ✅ | ✅ | 10 | `XAI_API_KEY` | ~0.5–2s | per-token (xAI pricing) |
| `embedding` | API | `bge-m3` | n/a | n/a | ❌ | 8 | Tailscale internal | ~0.2s | free (self-hosted) |

¹ Codex CLI supports `--output-schema` via raw flag, but Model Connector doesn't surface it through `responseFormat` yet; treat as `❌` for now (CONN-0044 / CONN-0045 ecosystem migration tracked).

## Decision Guide

### "I need structured output (json_schema strict mode)"

→ **`openrouter`**, **`groq`**, **`grok`**, or **`claude-code`** (only these enforce schema server-side).

CLI connectors that prompt-inject JSON instructions (`cursor`, `gemini`, `codex` via responseFormat) are NOT a substitute — they may return malformed JSON, no schema validation. Don't use them as drop-ins for Graphiti, Cognee, LangChain structured agents.

### "I need cheap / fast classification or NLU"

→ **`groq`** (sub-second, free) for Llama 3.3 / GPT-OSS / Qwen.
→ **`openrouter`** with `meta-llama/llama-4-maverick` if you need broader model catalogue.

### "I need code execution / file access / agent tools"

→ **`claude-code`** (Anthropic Claude with built-in tools, file system access via Docker volume mount).
→ **`cursor`** if you specifically need Cursor's workspace-aware composer behavior.

### "I need reasoning model"

→ **`grok`** with `grok-4-fast-reasoning` or `grok-4-1-fast-reasoning`.
→ **`codex`** with `o3` (heavier; OAuth tier-dependent).

### "I need embeddings (search, similarity)"

→ **`embedding`** (BGE-M3, dense + sparse + ColBERT + hybrid modes). Self-hosted on `arcana-db:8300` — free, no rate limit.

### "I need parallel high-throughput requests"

→ Any **API** connector (`openrouter`, `groq`, `grok`, `embedding`) — concurrency 8–10.
→ **AVOID `cursor`** — file-based state, hard limit 1 concurrent (`CURSOR_MAX_CONCURRENCY=1`).
→ CLI connectors (`claude-code`, `gemini`, `codex`) work concurrently up to 4 but pay subprocess spawn cost (~1–2s).

## Cost Tier Reference

| Tier | Connectors | Notes |
|------|-----------|-------|
| **Free (self-hosted)** | `embedding` | BGE-M3 on Arcanada DB server |
| **Free (provider quota)** | `groq` | 28 800 min/day, 7 200 req/day |
| **Subscription** | `claude-code`, `cursor` | Max plan / Cursor subscription |
| **OAuth tier** | `gemini`, `codex` | Google free tier / ChatGPT-tier |
| **Per-token API** | `openrouter`, `grok` | Pay-as-you-go billing |

## Operational Limits

- **Cloudflare proxy timeout:** ~100s. CLI connectors can exceed this → HTTP 524. Use Tailscale `http://100.121.155.54:3900` for bulk workloads.
- **HTTP 201, not 200:** all `/execute` success responses are 201. Check `status >= 400` for errors, not `!== 200`.
- **Auto-retry default:** 1 retry on transient errors (`json_parse_error`, `rate_limited`, `timeout`, `server_error`). Override with `CONNECTOR_MAX_RETRIES`.
- **Circuit breaker:** opens after 5 consecutive errors, 30s cooldown. Instant-open on `auth_error` / `binary_not_found`.

## See Also

- Per-connector pages: `docs/connectors/<name>.md`
- Architecture: `docs/architecture.md`
- README quick-start: `README.md`
