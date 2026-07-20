# Model Connector

Unified API server for AI CLI agents and cloud model providers. Send prompts to Claude Code, Cursor, Gemini CLI (and more) through a single HTTP endpoint.

> **One human life matters** — Arcanada Ecosystem

## What It Does

Model Connector wraps AI CLI tools as connectors behind a REST API. Each connector handles spawning the CLI process, parsing its output, classifying errors, and reporting token usage — so callers don't need to know the quirks of each tool.

**Supported connectors** (8 total — see [docs/capability-matrix.md](docs/capability-matrix.md) for full comparison):

| Connector | Type | Models | Auth | Avg Latency |
|-----------|------|--------|------|-------------|
| `claude-code` | CLI | claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5 | Subscription (Docker volume) | ~4s |
| `cursor` | CLI | auto, composer-2-fast, claude-4.6-sonnet/opus, gpt-5.4, gemini-3.1-pro | Subscription | ~10s |
| `gemini` | CLI | gemini-2.5-flash, gemini-3-flash-preview, gemini-2.5-flash-lite | Google OAuth (~/.gemini/) | ~8–22s |
| `codex` | CLI | o4-mini, o3, codex-mini-latest | OpenAI OAuth or `OPENAI_API_KEY` | ~6–12s |
| `openrouter` | API | 200+ models (Claude, GPT, Gemini, Llama, Mistral, etc.) | `OPENROUTER_API_KEY` | ~0.5–1s |
| `groq` | API | llama-3.3-70b, llama-3.1-8b, gpt-oss-120b/20b, qwen3-32b, groq/compound | `GROQ_API_KEY` (free tier) | ~0.15–0.7s |
| `grok` | API | grok-4-fast (+reasoning), grok-3, grok-3-mini, grok-code-fast-1 | `XAI_API_KEY` | ~0.5–2s |
| `embedding` | API | bge-m3 (dense, sparse, ColBERT, hybrid) | Internal (Tailscale) | ~0.2s |

Per-connector docs: `docs/connectors/<name>.md`. Architecture: `docs/architecture.md`.

## Quick Start

### Local Development

```bash
# Prerequisites: Node.js 22+, pnpm, PostgreSQL, Redis

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env  # edit with your DB/Redis credentials

# Generate Prisma client & push schema
pnpm db:generate
pnpm db:push

# Start dev server
pnpm dev
# Server runs on http://localhost:3900
```

### Docker (Production)

```bash
docker compose up -d --build
# Exposes on 127.0.0.1:3900 (use nginx reverse proxy for HTTPS)
```

## Client SDKs

First-party typed SDKs are published for TypeScript and Python.

### TypeScript — [`@arcanada/model-connector-sdk`](https://www.npmjs.com/package/@arcanada/model-connector-sdk)

```bash
pnpm add @arcanada/model-connector-sdk
```

```ts
import { Client } from '@arcanada/model-connector-sdk';

const client = new Client({ apiKey: process.env.ARC_API_KEY! });
const response = await client.execute({
  connector: 'openrouter',
  prompt: 'Explain BGE-M3 in 30 words.',
});
console.log(response.result);
```

Requires Node.js >= 20. Zero runtime dependencies (uses global `fetch`). Full guide: [`docs/sdk-typescript.md`](docs/sdk-typescript.md).

### Python — [`arcanada-model-connector`](https://pypi.org/project/arcanada-model-connector/)

```bash
pip install arcanada-model-connector
```

```python
from arcanada_model_connector import Client

client = Client(api_key="arc_api_...")
response = client.execute({"connector": "openrouter", "prompt": "ping"})
print(response.result)
```

Requires Python >= 3.10. Sync + async (`AsyncClient`). Full guide: [`docs/sdk-python.md`](docs/sdk-python.md).

Both SDKs expose the full `/execute` schema, including `output_format` / `schema` / `repair_report` from the v0.2.0 output-guard middleware, and surface typed error envelopes mapped 1:1 from the server contract.

## API

All endpoints except `/health` require Bearer token authentication.

### Health

```
GET /health          → { status: "ok", timestamp: "..." }
GET /health/ready    → { status: "ok", checks: { database: "ok" } }
```

### Connectors

```
GET /connectors                    → List all registered connectors with capabilities
GET /connectors/:name/status       → Connector health & active jobs
```

### Execute

**Universal endpoint** (specify connector in body):

```bash
curl -X POST https://connector.arcanada.ai/execute \
  -H "Authorization: Bearer <MODEL_CONNECTOR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "connector": "gemini",
    "prompt": "Explain recursion in one sentence",
    "model": "gemini-2.5-flash"
  }'
```

**Per-connector endpoint:**

```bash
curl -X POST https://connector.arcanada.ai/connectors/claude-code/execute \
  -H "Authorization: Bearer <MODEL_CONNECTOR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "What is 2+2?",
    "model": "sonnet"
  }'
```

### Request Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connector` | string | yes* | Connector name (*only for `/execute`) |
| `prompt` | string | yes | The prompt to send (max 100K chars) |
| `model` | string | no | Model override (default: connector's primary model) |
| `systemPrompt` | string | no | System prompt |
| `maxTurns` | number | no | Max agent turns (1-100) |
| `maxBudgetUsd` | number | no | Budget cap in USD (0-100) |
| `effort` | string | no | `low`, `medium`, or `high` |
| `jsonSchema` | object | no | JSON schema for structured output (Claude Code only) |
| `responseFormat` | object | no | `{ type: "json_object" }` — request JSON output |
| `output_format` | string | no | Output-guard format: `json` \| `yaml` \| `toml` \| `python` \| `auto` (default: `auto` — inferred from `responseFormat`/`schema`). See [Output Guard](#output-guard). |
| `schema` | object | no | JSON Schema for output-guard validation + repair (≤32 KiB). Triggers structured-output enforcement. See [Output Guard](#output-guard). |
| `timeout` | number | no | Timeout in ms (5000-600000, default: 120000) |
| `extra` | object | no | Connector-specific options (see below) |

### Connector-Specific `extra` Options

**claude-code:**
- `permissionMode` — `"bypassPermissions"` (default), `"plan"`, etc.
- `allowedTools` / `disallowedTools` — comma-separated tool names
- `fallbackModel` — fallback model on primary failure
- `thinking` — `"enabled"` / `"disabled"`
- `addDir` — additional directory context

**cursor:**
- `mode` — `"plan"`, `"normal"`, etc.
- `workspace` — workspace directory path

**gemini:**
- `sandbox` — `true` to enable sandbox mode

**openrouter / groq / grok:**
- `max_tokens` — max tokens in response
- `temperature` — sampling temperature (0–2)
- `top_p` — nucleus sampling

**codex:**
- `codexFlags` — extra raw CLI flags (passed through after `--full-auto --ephemeral --skip-git-repo-check`)

### JSON Mode (Structured Output)

Request JSON output from any connector:

```bash
curl -X POST https://connector.arcanada.ai/execute \
  -H "Authorization: Bearer <MODEL_CONNECTOR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "connector": "openrouter",
    "prompt": "List 3 programming languages with year created",
    "responseFormat": { "type": "json_object" }
  }'
```

**Behavior by connector:**
- **OpenRouter / Groq / Grok** — pass `response_format: { type: "json_object" }` (or `json_schema` strict) to provider API (native, server-validated)
- **Claude Code** — uses `--json-schema` if `jsonSchema` provided; otherwise prepends JSON system prompt
- **Cursor / Gemini / Codex** — prepends JSON instruction to prompt (no native JSON mode; not server-validated, may return malformed JSON)
- **Embedding** — n/a (returns vector, not LLM text)

### Output Guard

Since **v0.2.0** the `/execute` endpoint runs an **output-guard middleware** that enforces structured output across all connectors — including CLI connectors that lack native JSON-schema support.

**Trigger:** request includes `schema` (JSON Schema) or `output_format` (`json` / `yaml` / `toml` / `python`).

**Pipeline:**

1. **Native pass** — provider-native structured output is used when available (OpenRouter/Groq/Grok `response_format`, Claude Code `--json-schema`).
2. **Repair pass** — on parse/validation failure, deterministic repair strategies are applied (fence-strip, trailing-comma fix, quote normalisation, balanced-bracket trim, etc.).
3. **Retry pass** — if still invalid, the request is re-issued to the LLM with a corrective system prompt, up to `OUTPUT_GUARD_MAX_RETRIES` times.
4. **Surface** — final output + `repair_report` envelope (see [Response Schema](#response-schema)).

**Example — strict JSON Schema:**

```bash
curl -X POST https://connector.arcanada.ai/execute \
  -H "Authorization: Bearer <MODEL_CONNECTOR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "connector": "cursor",
    "prompt": "List 3 programming languages with year created",
    "output_format": "json",
    "schema": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "language": {"type": "string"}, "year": {"type": "integer"} },
        "required": ["language", "year"]
      }
    }
  }'
```

**Configuration:** see `OUTPUT_GUARD_ENABLED`, `OUTPUT_GUARD_MAX_RETRIES`, `OUTPUT_GUARD_TIMEOUT_MS` in [Environment Variables](#environment-variables).

**Full guide:** [`docs/how-to/use-output-guard.md`](docs/how-to/use-output-guard.md).

### Response Schema

```json
{
  "id": "uuid",
  "connector": "gemini",
  "model": "gemini-2.5-flash",
  "result": "Recursion is when a function calls itself.",
  "structured": { "sessionId": "..." },
  "usage": {
    "inputTokens": 5181,
    "outputTokens": 12,
    "totalTokens": 5193,
    "costUsd": 0
  },
  "latencyMs": 2400,
  "queueWaitMs": 5,
  "attempt": 1,
  "maxAttempts": 2,
  "status": "success",
  "error": null
}
```

**Status values:** `success`, `error`, `timeout`, `rate_limited`

**New response fields (v0.1.x):**
- `queueWaitMs` — time spent waiting in concurrency queue (ms)
- `attempt` — current attempt number (1-based)
- `maxAttempts` — total attempts allowed (1 + CONNECTOR_MAX_RETRIES)

**Output-guard response field (v0.2.0):**

When `schema` or `output_format` is set on the request, the response includes a `repair_report` envelope:

```json
{
  "repair_report": {
    "strategies_applied": ["fence-strip", "trailing-comma"],
    "retries": 1,
    "final_valid": true,
    "pass": "guarded",
    "error": null
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `strategies_applied` | string[] | Repair strategies executed (e.g. `fence-strip`, `trailing-comma`, `quote-fix`) |
| `retries` | number | Number of LLM retries performed (≤ `OUTPUT_GUARD_MAX_RETRIES`) |
| `final_valid` | boolean | Whether final output passed schema validation |
| `pass` | string | `native` (provider-native JSON), `guarded` (post-repair), or `failed` |
| `error` | string \| null | Failure reason when `pass = "failed"`, else `null` |

See [Output Guard](#output-guard) for full behavior.

### Error Response

When `status` is not `success`, the `error` object includes:

```json
{
  "error": {
    "type": "json_parse_error",
    "message": "Failed to parse JSON response",
    "retryable": true,
    "recommendation": "retry"
  }
}
```

| error.type | retryable | recommendation | HTTP status |
|---|---|---|---|
| `rate_limited` | true | `wait` | 429 |
| `timeout` | true | `retry` | 201 |
| `server_error` | true | `retry` | 201 |
| `json_parse_error` | true | `retry` | 201 |
| `execution_error` | true | `retry` | 201 |
| `queue_timeout` | true | `wait` | 503 |
| `circuit_open` | false | `wait` | 503 |
| `auth_error` | false | `reauth` | 503 |
| `binary_not_found` | false | `abort` | 503 |
| `validation_error` | false | `abort` | 400 |

**`recommendation` values:**
- `retry` — resend the same request after a short delay
- `wait` — wait for `retryAfter` ms or the indicated cooldown, then retry
- `abort` — do not retry; fix the request or configuration
- `reauth` — re-authenticate the connector (CLI login expired)

### Circuit Breaker

Each connector has an independent circuit breaker. After `CIRCUIT_BREAKER_THRESHOLD` consecutive errors (default: 5), the connector enters `open` state and rejects requests with `circuit_open` for `CIRCUIT_BREAKER_COOLDOWN_MS` (default: 30s). After cooldown, one probe request is allowed (`half_open`). Success resets the breaker; failure re-opens it.

`auth_error` and `binary_not_found` instantly open the circuit (no threshold wait).

Check circuit state: `GET /connectors/:name/status` → `circuitBreaker: { state, consecutiveFailures, nextRetryAt }`

### Auto-Retry

MC automatically retries transient errors (json_parse_error, rate_limited, timeout, server_error) up to `CONNECTOR_MAX_RETRIES` times (default: 1). Exponential backoff with jitter: 1s, 2s, 4s (max 8s). Non-retryable errors (auth_error, validation_error, etc.) are returned immediately.

### JSON Sanitization

When `responseFormat: { type: "json_object" }` is set, MC sanitizes the response:
1. Strips BOM and whitespace
2. Removes markdown code fences (` ```json ... ``` `)
3. Extracts JSON by bracket matching
4. Validates with `JSON.parse()`

The cleaned JSON is placed in `response.structured`. If sanitization fails after all retries, `error.type` is `json_parse_error`.

## Authentication

API keys are stored bcrypt-hashed in the `ApiKey` PostgreSQL table on arcana-db. Every request (кроме `/health`) требует заголовок `Authorization: Bearer <key>`.

### Как получить ключ

**Шаг 1. Сгенерировать случайный ключ:**

```bash
# Формат: mc-<service-name>-<random>
openssl rand -hex 16 | sed 's/^/mc-myservice-/'
# Пример результата: <MODEL_CONNECTOR_API_KEY>
```

**Шаг 2. Получить bcrypt-хеш** (на PROD сервере):

```bash
ssh root@65.108.236.39
docker exec model-connector-model-connector-1 node -e \
  "const b=require('bcryptjs');b.hash('<MODEL_CONNECTOR_API_KEY>',10).then(h=>console.log(h))"
# → $2b$10$4IDeokFW7NPv6958W56LS.QcOHxzqVFwBkoF6YfzYGDQDgZrdViDu
```

**Шаг 3. Вставить в базу:**

```bash
# Подключение к БД (с любого сервера в Tailscale)
psql "postgresql://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:5432/<DB_NAME>"
```

```sql
INSERT INTO "ApiKey" (id, name, "hashedKey", "createdAt")
VALUES (
  gen_random_uuid(),
  'myservice',                    -- человекочитаемое имя
  '$2b$10$4IDeo...<полный хеш>', -- результат шага 2
  NOW()
);
```

**Шаг 4. Использовать** в `.env` вашего проекта:

```env
MC_URL=http://100.121.155.54:3900    # для серверов в Tailscale
MC_API_KEY=<MODEL_CONNECTOR_API_KEY>  # raw ключ (не хеш!)
```

### Проверить ключ

```bash
curl -s https://connector.arcanada.ai/connectors \
  -H "Authorization: Bearer <MODEL_CONNECTOR_API_KEY>"
# 200 + JSON → ключ работает
# 401 → ключ невалиден
```

### Существующие ключи

| Имя | Назначение | Создан |
|-----|-----------|--------|
| `demo-test` | тестирование / smoke tests | 2026-04-20 |

> **Безопасность:** raw-ключ знает только владелец сервиса. В базе хранится только bcrypt-хеш. При компрометации — удалите строку из `ApiKey` и создайте новый ключ.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                   NestJS + Fastify                          │
│                                                            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                    │
│  │  Auth   │  │ Health  │  │  Queue  │                    │
│  │  Guard  │  │ /health │  │ BullMQ  │                    │
│  └─────────┘  └─────────┘  └─────────┘                    │
│                                                            │
│  ┌────────────────────────────────────────────┐            │
│  │            ConnectorsService               │            │
│  │  register() / execute() / retry / metrics  │            │
│  └────────────────────────────────────────────┘            │
│       │             │           │           │              │
│   ┌───┴───┐  ┌──────┴──┐  ┌────┴───┐  ┌───┴───┐           │
│   │Claude │  │ Cursor  │  │ Gemini │  │ Codex │ ← CLI     │
│   │ Code  │  │  Agent  │  │  CLI   │  │  CLI  │           │
│   └───┬───┘  └────┬────┘  └────┬───┘  └───┬───┘           │
│       └───────────┴────────────┴──────────┘                │
│                       │                                    │
│           ┌───────────┴────────────┐                       │
│           │   BaseCliConnector     │                       │
│           │ spawn → parse → classify│                      │
│           └────────────────────────┘                       │
│                                                            │
│   ┌──────────┐  ┌──────┐  ┌──────┐  ┌──────────┐          │
│   │OpenRouter│  │ Groq │  │ Grok │  │Embedding │ ← API    │
│   │200+ mdls │  │free  │  │ xAI  │  │ BGE-M3   │          │
│   └─────┬────┘  └──┬───┘  └──┬───┘  └────┬─────┘          │
│         └──────────┴─────────┴───────────┘                 │
│                       │                                    │
│           ┌───────────┴────────────┐                       │
│           │   BaseApiConnector     │                       │
│           │ fetch → parse → classify│                      │
│           └────────────────────────┘                       │
│                                                            │
│   Both base classes share:                                 │
│   • Semaphore (concurrency + queue timeout)                │
│   • CircuitBreakerManager (per connector:model)            │
│   • Error classifier (17+ error types)                     │
└────────────────────────────────────────────────────────────┘
```

Подробнее: [docs/architecture.md](docs/architecture.md).

**Adding a new OpenAI-compat API connector:** copy `templates/api-connector-scaffold/` → `src/connectors/<name>/`, follow the README inside (9 placeholders, post-gen checklist, ≤30 min walkthrough).

## Commands

```bash
pnpm dev          # Start development server (watch mode)
pnpm build        # Build for production
pnpm test         # Run all tests
pnpm lint         # Lint TypeScript files
pnpm db:generate  # Generate Prisma client
pnpm db:push      # Push schema to database
```

## Tech Stack

- **Runtime:** Node.js 22+
- **Framework:** NestJS + Fastify
- **Language:** TypeScript (strict)
- **ORM:** Prisma 7 (driver adapter pattern)
- **Validation:** Zod
- **Queue:** BullMQ + Redis
- **Testing:** Vitest (188 tests)
- **CI/CD:** GitHub Actions → SSH deploy to Arcanada PROD

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_HOST` | yes | Redis host |
| `REDIS_PORT` | no | Redis port (default: 6379) |
| `REDIS_PASSWORD` | yes | Redis password |
| `PORT` | no | Server port (default: 3900) |
| `OPENROUTER_API_KEY` | yes* | OpenRouter API key (*required for `openrouter` connector) |
| `OPENROUTER_TIMEOUT_MS` | no | OpenRouter timeout (default: 120000) |
| `GROQ_API_KEY` | yes* | Groq API key (*required for `groq` connector — https://console.groq.com/keys) |
| `GROQ_TIMEOUT_MS` | no | Groq timeout (default: 120000) |
| `XAI_API_KEY` | yes* | xAI API key (*required for `grok` connector — https://console.x.ai/) |
| `GROK_TIMEOUT_MS` | no | Grok timeout (default: 120000) |
| `OPENAI_API_KEY` | no | Optional for `codex` (otherwise OAuth via chatgpt.com) |
| `CLAUDE_BINARY_PATH` | no | Path to Claude CLI (default: `claude`) |
| `CURSOR_BINARY_PATH` | no | Path to Cursor CLI (default: `cursor-agent`) |
| `GEMINI_BINARY_PATH` | no | Path to Gemini CLI (default: `gemini`) |
| `CONNECTOR_TIMEOUT_MS` | no | Default execution timeout (default: 120000) |
| `CONNECTOR_MAX_CONCURRENCY` | no | Global fallback concurrency limit (default: 4) |
| `CLAUDE_CODE_MAX_CONCURRENCY` | no | Claude Code CLI concurrent limit (default: 4) |
| `CURSOR_MAX_CONCURRENCY` | no | Cursor CLI concurrent limit (default: **1** — DO NOT INCREASE) |
| `GEMINI_MAX_CONCURRENCY` | no | Gemini CLI concurrent limit (default: 4) |
| `OPENROUTER_MAX_CONCURRENCY` | no | OpenRouter API concurrent limit (default: 10) |
| `GROQ_MAX_CONCURRENCY` | no | Groq API concurrent limit (default: 10) |
| `GROK_MAX_CONCURRENCY` | no | Grok API concurrent limit (default: 10) |
| `EMBEDDING_MAX_CONCURRENCY` | no | Embedding API concurrent limit (default: 8) |
| `CONNECTOR_QUEUE_TIMEOUT_MS` | no | Max wait time in concurrency queue (default: 60000) |
| `CONNECTOR_MAX_RETRIES` | no | Auto-retries on transient errors (default: 1, 0=disabled) |
| `CIRCUIT_BREAKER_THRESHOLD` | no | Consecutive failures to open circuit (default: 5) |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | no | Circuit breaker cooldown (default: 30000) |
| `OUTPUT_GUARD_ENABLED` | no | Enable output-guard middleware on `/execute` (default: `true`) |
| `OUTPUT_GUARD_MAX_RETRIES` | no | Max LLM retries inside output-guard repair pipeline (default: `3`) |
| `OUTPUT_GUARD_TIMEOUT_MS` | no | Total budget for output-guard pipeline incl. retries (default: `30000`) |

## Integration Guide for Arcanada Projects

### Подключение

| Параметр | Из интернета | Из Tailscale (серверы экосистемы) |
|----------|-------------|----------------------------------|
| **URL** | `https://connector.arcanada.ai` | `http://100.121.155.54:3900` |
| **Протокол** | HTTPS (Cloudflare → nginx → :3900) | HTTP напрямую (без прокси) |
| **Auth** | `Authorization: Bearer <API_KEY>` | `Authorization: Bearer <API_KEY>` |
| **Таймаут Cloudflare** | ~100s (HTTP 524 при превышении) | нет ограничения |
| **Для кого** | внешние клиенты, локальная разработка | Ops Bot, Scrutator, LTM, Email Agent, PA |

> **HTTP 201**, не 200 — MC возвращает 201 Created на успешный `/execute`. Проверяйте `status >= 400` для ошибок.

> **API-ключ:** см. раздел [Authentication](#authentication) выше — пошаговая инструкция создания ключа для вашего сервиса.

**API-ключ** — bcrypt-хеш в PostgreSQL таблице `ApiKey` на arcana-db. Создать через [Admin API](#admin-api--управление-ключами) (рекомендуется) или вручную через SQL.

### Endpoints

```
GET  /health                        → health check (без auth)
GET  /connectors                    → список коннекторов и capabilities
POST /connectors/:name/execute      → запрос к конкретному коннектору
POST /execute                       → универсальный (поле "connector" в body)
```

### Примеры: OpenRouter (рекомендован для большинства задач)

**curl:**

```bash
# Из интернета / с локальной машины:
curl -X POST https://connector.arcanada.ai/connectors/openrouter/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Classify: The server is on fire",
    "model": "meta-llama/llama-4-maverick",
    "systemPrompt": "Respond: critical/warning/info",
    "extra": {"temperature": 0, "max_tokens": 10}
  }'

# С сервера экосистемы (Tailscale, без Cloudflare):
curl -X POST http://100.121.155.54:3900/connectors/openrouter/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "model": "meta-llama/llama-4-maverick"}'
```

**TypeScript (NestJS / Node.js):**

```typescript
// .env: MC_API_KEY=your-key
// С сервера экосистемы используйте http://100.121.155.54:3900
const MC_URL = process.env.MC_URL || 'https://connector.arcanada.ai';
const MC_KEY = process.env.MC_API_KEY;

async function askLLM(prompt: string, model?: string): Promise<string> {
  const res = await fetch(`${MC_URL}/connectors/openrouter/execute`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MC_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model: model ?? 'meta-llama/llama-4-maverick',
      extra: { max_tokens: 500 },
    }),
  });

  if (res.status >= 400) throw new Error(`MC error: ${res.status}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.error?.message);
  return data.result;
}
```

**Python (httpx):**

```python
import os, httpx

# С сервера экосистемы используйте http://100.121.155.54:3900
MC_URL = os.environ.get("MC_URL", "https://connector.arcanada.ai")
MC_KEY = os.environ["MC_API_KEY"]

async def ask_llm(prompt: str, model: str = "meta-llama/llama-4-maverick") -> str:
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            f"{MC_URL}/connectors/openrouter/execute",
            headers={"Authorization": f"Bearer {MC_KEY}"},
            json={"prompt": prompt, "model": model, "extra": {"max_tokens": 500}},
        )
        res.raise_for_status()
        data = res.json()
        if data["status"] != "success":
            raise RuntimeError(data.get("error", {}).get("message"))
        return data["result"]
```

### Примеры: другие коннекторы

```bash
# Claude Code (CLI, ~4s, нужен для file access / code execution)
curl -X POST https://connector.arcanada.ai/connectors/claude-code/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is 2+2?", "maxTurns": 1}'

# Embedding (BGE-M3, ~0.2s, self-hosted на arcana-db)
curl -X POST https://connector.arcanada.ai/connectors/embedding/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "your text here"}'

# Embedding — sparse / hybrid / colbert режимы
curl -X POST https://connector.arcanada.ai/connectors/embedding/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "text", "extra": {"embeddingType": "hybrid"}}'

# Универсальный endpoint (connector в body)
curl -X POST https://connector.arcanada.ai/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connector": "openrouter", "prompt": "Hello", "model": "openai/gpt-4o-mini"}'
```

### Какой коннектор выбрать

| Задача | Коннектор | Модель | Latency | Цена |
|--------|-----------|--------|---------|------|
| NLU, классификация, парсинг (free) | `groq` | `llama-3.1-8b-instant` | ~0.15s | **free tier** |
| NLU, классификация, парсинг (catalog) | `openrouter` | `meta-llama/llama-4-maverick` | ~0.5s | free |
| Генерация текста (качество) | `openrouter` | `anthropic/claude-sonnet-4` | ~1s | $3 / 1M in |
| Дешёвая генерация | `openrouter` | `openai/gpt-4o-mini` | ~0.5s | $0.15 / 1M in |
| Reasoning (математика, планирование) | `grok` | `grok-4-fast-reasoning` | ~1–2s | xAI per-token |
| Структурированный вывод (json_schema) | `openrouter` / `groq` / `grok` | любая | ~0.5–1s | per-model |
| Работа с файлами / code exec | `claude-code` | sonnet / haiku | ~4s | subscription |
| Embeddings (поиск, similarity) | `embedding` | `bge-m3` | ~0.2s | free (self-hosted) |
| Agent с Cursor tools | `cursor` | `auto` | ~10s | subscription |
| OpenAI reasoning (`o3`, `o4-mini`) | `codex` | `o4-mini` | ~6–12s | ChatGPT-tier |

Развёрнутая таблица: [docs/capability-matrix.md](docs/capability-matrix.md).

### Формат ответа (единый для всех коннекторов)

```json
{
  "id": "9f3858e7-03af-4560-a5f1-aeeb3eff5840",
  "connector": "openrouter",
  "model": "meta-llama/llama-4-maverick-17b-128e-instruct",
  "result": "Tokyo.",
  "usage": {
    "inputTokens": 22,
    "outputTokens": 3,
    "totalTokens": 25,
    "costUsd": 0
  },
  "latencyMs": 659,
  "status": "success"
}
```

`status`: `success` | `error` | `timeout` | `rate_limited`

### Обработка ошибок

```typescript
const res = await fetch(`${MC_URL}/connectors/openrouter/execute`, { ... });

// HTTP-уровень: MC вернёт 4xx/5xx при невалидном запросе или внутренней ошибке
if (res.status >= 400) throw new Error(`MC HTTP ${res.status}`);

// Бизнес-уровень: коннектор выполнился, но модель вернула ошибку
const data = await res.json();
if (data.status === 'rate_limited') { /* подождать data.error.retryAfter */ }
if (data.status === 'timeout')      { /* retry или fallback-коннектор */ }
if (data.status === 'error')        { /* data.error.type + data.error.message */ }
```

### Admin API — Управление ключами

Вместо ручного SQL теперь можно управлять ключами через REST API.

**Требование:** переменная `ADMIN_TOKEN` (≥32 символов) в `.env` на сервере.

```bash
# Генерация admin token:
openssl rand -hex 32
# → добавить в .env: ADMIN_TOKEN=<value>
```

**Создать ключ:**

```bash
curl -X POST https://connector.arcanada.ai/admin/keys \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-service", "rateLimit": 120}'

# Ответ (201):
# {"id": "uuid", "name": "my-service", "key": "<MODEL_CONNECTOR_API_KEY>"}
# ⚠️ key возвращается ТОЛЬКО в этом ответе — сохраните его!
```

**Список ключей:**

```bash
curl https://connector.arcanada.ai/admin/keys \
  -H "X-Admin-Token: $ADMIN_TOKEN"

# Ответ: [{"id": "...", "name": "my-service", "rateLimit": 120, "active": true, "createdAt": "..."}]
```

**Деактивировать ключ:**

```bash
curl -X DELETE https://connector.arcanada.ai/admin/keys/<id> \
  -H "X-Admin-Token: $ADMIN_TOKEN"

# Ответ: 204 No Content
```

### Benchmark (PROD)

Snapshot 2026-04-20:

| Connector | R1 | R2 | R3 | Avg |
|-----------|----|----|-----|-----|
| openrouter | 0.66s | 0.94s | 0.32s | **0.64s** |
| embedding | 0.27s | 0.25s | 0.22s | **0.25s** |
| claude-code | 4.0s | 4.3s | 4.4s | **4.2s** |
| cursor | 12.1s | 9.3s | 9.5s | **10.3s** |
| gemini | 6.9s | 22.1s | 21.5s | **16.8s** |

Live smoke (2026-04-27 → 2026-04-29):

| Connector | Default model | First call | Notes |
|-----------|---------------|------------|-------|
| groq | `llama-3.3-70b-versatile` | ~0.74s | free tier, json_object verified |
| grok | `grok-4-fast` | ~0.5–2s | json_schema strict supported |

## License

MIT

## Links

- **Live:** https://connector.arcanada.ai
- **GitHub:** https://github.com/Arcanada-one/model-connector
- **Ecosystem:** https://arcanada.ai
