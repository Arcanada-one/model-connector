# Model Connector

Unified API server for AI CLI agents and cloud model providers. Send prompts to Claude Code, Cursor, Gemini CLI (and more) through a single HTTP endpoint.

> **One human life matters** — Arcanada Ecosystem

## What It Does

Model Connector wraps AI CLI tools as connectors behind a REST API. Each connector handles spawning the CLI process, parsing its output, classifying errors, and reporting token usage — so callers don't need to know the quirks of each tool.

**Supported connectors:**

| Connector | Type | Models | Auth | Avg Latency |
|-----------|------|--------|------|-------------|
| `claude-code` | CLI | claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5 | Subscription (Docker volume) | ~4s |
| `cursor` | CLI | cursor-auto, gpt-5, sonnet-4, sonnet-4-thinking | API key | ~10s |
| `gemini` | CLI | gemini-2.5-flash, gemini-3-flash-preview, gemini-2.5-flash-lite | OAuth (~/.gemini/) | ~8-22s |
| `openrouter` | API | 200+ models (Claude, GPT, Gemini, Llama, Mistral, etc.) | API key (OPENROUTER_API_KEY) | ~0.5-1s |
| `embedding` | API | bge-m3 (dense, sparse, ColBERT, hybrid) | Internal (Tailscale) | ~0.2s |

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
curl -X POST https://connector.arcanada.one/execute \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "connector": "gemini",
    "prompt": "Explain recursion in one sentence",
    "model": "gemini-2.5-flash"
  }'
```

**Per-connector endpoint:**

```bash
curl -X POST https://connector.arcanada.one/connectors/claude-code/execute \
  -H "Authorization: Bearer YOUR_API_KEY" \
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
| `jsonSchema` | object | no | JSON schema for structured output |
| `timeout` | number | no | Timeout in ms (5000-600000, default: 300000) |
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

**openrouter:**
- `max_tokens` — max tokens in response
- `temperature` — sampling temperature (0-2)
- `top_p` — nucleus sampling

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
  "status": "success",
  "error": null
}
```

**Status values:** `success`, `error`, `timeout`, `rate_limited`

## Authentication

API keys are stored bcrypt-hashed in the `ApiKey` PostgreSQL table. To create a key:

```sql
-- Generate a bcrypt hash of your key, then insert:
INSERT INTO "ApiKey" (id, name, "hashedKey", "createdAt")
VALUES (gen_random_uuid(), 'my-client', '$2b$10$...', NOW());
```

Pass the raw key as `Authorization: Bearer <key>` on every request.

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                  NestJS + Fastify                      │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │  Auth     │  │  Health   │  │  Queue   │            │
│  │  Guard    │  │  /health  │  │  BullMQ  │            │
│  └──────────┘  └──────────┘  └──────────┘            │
│                                                       │
│  ┌───────────────────────────────────────────────────┐│
│  │              ConnectorsService                    ││
│  │       register() / execute() / enqueue()          ││
│  └───────────────────────────────────────────────────┘│
│       │            │            │       │        │    │
│  ┌────┴───┐  ┌─────┴────┐  ┌───┴────┐  │        │    │
│  │ Claude  │  │  Cursor   │  │ Gemini │  │        │    │
│  │ Code    │  │  Agent    │  │  CLI   │  │        │    │
│  └────┬───┘  └─────┬────┘  └───┬────┘  │        │    │
│       │            │            │       │        │    │
│  ┌────┴────────────┴────────────┴────┐  │        │    │
│  │       BaseCliConnector            │  │        │    │
│  │  spawn() → parse() → classify()  │  │        │    │
│  └───────────────────────────────────┘  │        │    │
│                                         │        │    │
│  ┌──────────────┐  ┌───────────────┐    │        │    │
│  │  OpenRouter   │  │  Embedding    │◄───┘────────┘    │
│  │  (200+ models)│  │  (BGE-M3)    │                   │
│  └──────┬───────┘  └──────┬───────┘                   │
│         │                  │                           │
│  ┌──────┴──────────────────┴──────────┐               │
│  │         BaseApiConnector           │               │
│  │    fetch() → parse() → classify()  │               │
│  └────────────────────────────────────┘               │
└───────────────────────────────────────────────────────┘
```

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
- **Testing:** Vitest (128 tests)
- **CI/CD:** GitHub Actions → SSH deploy to Arcanada PROD

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_HOST` | yes | Redis host |
| `REDIS_PORT` | no | Redis port (default: 6379) |
| `REDIS_PASSWORD` | yes | Redis password |
| `PORT` | no | Server port (default: 3900) |
| `OPENROUTER_API_KEY` | yes* | OpenRouter API key (*required for openrouter connector) |
| `OPENROUTER_TIMEOUT_MS` | no | OpenRouter timeout (default: 120000) |
| `CLAUDE_BINARY_PATH` | no | Path to Claude CLI (default: `claude`) |
| `CURSOR_BINARY_PATH` | no | Path to Cursor CLI (default: `cursor-agent`) |
| `GEMINI_BINARY_PATH` | no | Path to Gemini CLI (default: `gemini`) |

## Integration Guide for Arcanada Projects

Model Connector — единая точка входа для всех AI-моделей в экосистеме. Вместо прямых вызовов к OpenRouter / Anthropic / OpenAI, проекты ходят через MC и получают единый формат ответа, учёт токенов и стоимости, fallback между моделями.

### Базовая настройка

```
Base URL:  https://connector.arcanada.one
Auth:      Authorization: Bearer <API_KEY>
Response:  HTTP 201 (не 200!) для успешных запросов
```

> **Важно:** MC возвращает HTTP **201 Created**, не 200. Проверяйте `status >= 400` для ошибок.

### OpenRouter — быстрый доступ к 200+ моделям

OpenRouter — самый быстрый LLM-коннектор (~0.5-1s vs 4-22s у CLI). Рекомендуется для задач, где не нужны CLI-инструменты (file access, code execution).

**curl:**

```bash
# Простой запрос (дефолт: anthropic/claude-sonnet-4)
curl -X POST https://connector.arcanada.one/connectors/openrouter/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain recursion in one sentence"}'

# С выбором модели и системным промптом
curl -X POST https://connector.arcanada.one/connectors/openrouter/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Classify this text: The server is on fire",
    "model": "meta-llama/llama-4-maverick",
    "systemPrompt": "You are a classifier. Respond with: critical/warning/info",
    "extra": {"temperature": 0, "max_tokens": 10}
  }'
```

**TypeScript (NestJS / Node.js):**

```typescript
const MC_URL = 'https://connector.arcanada.one';
const MC_KEY = process.env.MC_API_KEY;

async function askOpenRouter(prompt: string, model?: string): Promise<string> {
  const res = await fetch(`${MC_URL}/connectors/openrouter/execute`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MC_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model: model ?? 'meta-llama/llama-4-maverick', // free
      extra: { max_tokens: 500 },
    }),
  });

  if (res.status >= 400) throw new Error(`MC error: ${res.status}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.error?.message);
  return data.result;
}
```

**Python (httpx / requests):**

```python
import httpx

MC_URL = "https://connector.arcanada.one"
MC_KEY = os.environ["MC_API_KEY"]

async def ask_openrouter(prompt: str, model: str = "meta-llama/llama-4-maverick") -> str:
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            f"{MC_URL}/connectors/openrouter/execute",
            headers={"Authorization": f"Bearer {MC_KEY}"},
            json={
                "prompt": prompt,
                "model": model,
                "extra": {"max_tokens": 500},
            },
        )
        res.raise_for_status()
        data = res.json()
        if data["status"] != "success":
            raise RuntimeError(data.get("error", {}).get("message", "Unknown error"))
        return data["result"]
```

### Универсальный endpoint (любой коннектор)

Вместо per-connector endpoints можно использовать `/execute` с полем `connector`:

```bash
# OpenRouter через универсальный endpoint
curl -X POST https://connector.arcanada.one/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connector": "openrouter", "prompt": "Hello", "model": "openai/gpt-4o-mini"}'

# Claude Code через универсальный endpoint
curl -X POST https://connector.arcanada.one/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connector": "claude-code", "prompt": "What is 2+2?", "maxTurns": 1}'

# Embeddings через универсальный endpoint
curl -X POST https://connector.arcanada.one/execute \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connector": "embedding", "prompt": "your text here"}'
```

### Какой коннектор выбрать

| Задача | Коннектор | Модель | Почему |
|--------|-----------|--------|--------|
| Классификация, NLU, парсинг | `openrouter` | `meta-llama/llama-4-maverick` (free) | Быстро (~0.5s), бесплатно |
| Генерация текста (качество) | `openrouter` | `anthropic/claude-sonnet-4` | Быстрее CLI, cost tracking |
| Дешёвая генерация | `openrouter` | `openai/gpt-4o-mini` | $0.15/1M input |
| Работа с файлами / code execution | `claude-code` | haiku/sonnet | Полный доступ к CLI tools |
| Embeddings (поиск, similarity) | `embedding` | `bge-m3` | <0.3s, бесплатно (self-hosted) |
| Agent с Cursor tools | `cursor` | cursor-auto | Cursor-specific features |

### Формат ответа (все коннекторы)

```json
{
  "id": "uuid",
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

### Обработка ошибок

```typescript
const data = await res.json();

switch (data.status) {
  case 'success':      // все ок
    return data.result;
  case 'error':        // ошибка API/модели
    console.error(data.error?.type, data.error?.message);
    break;
  case 'timeout':      // превышен таймаут
    // retry or fallback
    break;
  case 'rate_limited': // лимит превышен
    const retryAfter = data.error?.retryAfter;
    break;
}
```

### Benchmark (PROD, 2026-04-20)

| Connector | R1 | R2 | R3 | Avg |
|-----------|----|----|-----|-----|
| claude-code | 4.0s | 4.3s | 4.4s | 4.2s |
| cursor | 12.1s | 9.3s | 9.5s | 10.3s |
| gemini | 6.9s | 22.1s | 21.5s | 16.8s |
| embedding | 0.27s | 0.25s | 0.22s | 0.25s |
| openrouter | 0.66s | 0.94s | 0.32s | 0.64s |

## License

MIT

## Links

- **Live:** https://connector.arcanada.one
- **GitHub:** https://github.com/Arcanada-one/model-connector
- **Ecosystem:** https://arcanada.one
