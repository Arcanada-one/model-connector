# Model Connector

Unified API server for AI CLI agents and cloud model providers. Send prompts to Claude Code, Cursor, Gemini CLI (and more) through a single HTTP endpoint.

> **One human life matters** — Arcanada Ecosystem

## What It Does

Model Connector wraps AI CLI tools as connectors behind a REST API. Each connector handles spawning the CLI process, parsing its output, classifying errors, and reporting token usage — so callers don't need to know the quirks of each tool.

**Supported connectors:**

| Connector | CLI Tool | Models | Auth |
|-----------|----------|--------|------|
| `claude-code` | Claude Code CLI | claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5 | Subscription (Docker volume) |
| `cursor` | Cursor Agent CLI | cursor-auto, gpt-5, sonnet-4, sonnet-4-thinking | API key |
| `gemini` | Gemini CLI | gemini-2.5-flash, gemini-3-flash-preview, gemini-2.5-flash-lite | OAuth (~/.gemini/) |
| `embedding` | OpenAI-compatible API | text-embedding-3-small, etc. | API key |

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
┌──────────────────────────────────────────┐
│              NestJS + Fastify            │
│                                          │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐ │
│  │  Auth    │  │  Health  │  │  Queue   │ │
│  │  Guard   │  │  /health │  │  BullMQ  │ │
│  └─────────┘  └─────────┘  └──────────┘ │
│                                          │
│  ┌──────────────────────────────────────┐│
│  │         ConnectorsService            ││
│  │  register() / execute() / enqueue()  ││
│  └──────────────────────────────────────┘│
│       │            │            │        │
│  ┌────┴───┐  ┌─────┴────┐  ┌───┴──────┐ │
│  │ Claude  │  │  Cursor   │  │  Gemini  │ │
│  │ Code    │  │  Agent    │  │  CLI     │ │
│  └────┬───┘  └─────┬────┘  └───┬──────┘ │
│       │            │            │        │
│  ┌────┴────────────┴────────────┴──────┐ │
│  │        BaseCliConnector             │ │
│  │  spawn() → parse() → classify()    │ │
│  └─────────────────────────────────────┘ │
└──────────────────────────────────────────┘
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
- **Testing:** Vitest (104 tests)
- **CI/CD:** GitHub Actions → SSH deploy to Arcanada AI

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_HOST` | yes | Redis host |
| `REDIS_PORT` | no | Redis port (default: 6379) |
| `REDIS_PASSWORD` | yes | Redis password |
| `PORT` | no | Server port (default: 3900) |
| `CLAUDE_BINARY_PATH` | no | Path to Claude CLI (default: `claude`) |
| `CURSOR_BINARY_PATH` | no | Path to Cursor CLI (default: `cursor-agent`) |
| `GEMINI_BINARY_PATH` | no | Path to Gemini CLI (default: `gemini`) |

## License

MIT

## Links

- **Live:** https://connector.arcanada.one
- **GitHub:** https://github.com/Arcanada-one/model-connector
- **Ecosystem:** https://arcanada.one
