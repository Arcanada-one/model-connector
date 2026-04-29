# Architecture

How Model Connector is structured internally.

## High-Level

```
Client
  │
  ▼
NestJS + Fastify (port 3900)
  │
  ├── AuthGuard (Bearer API key, bcrypt) ───── public: /health
  │
  ▼
ConnectorsController
  │
  ▼
ConnectorsService
  ├── retry loop (exponential backoff + jitter)
  ├── circuit breaker manager
  ├── metrics (in-memory, per connector:model)
  └── DB log (Prisma, fire-and-forget)
  │
  ▼
IConnector implementation
  ├── BaseCliConnector (abstract)
  │     ├── ClaudeCodeConnector  (`claude` binary)
  │     ├── CursorConnector      (`cursor-agent` binary)
  │     ├── GeminiConnector      (`gemini` binary)
  │     └── CodexConnector       (`codex` binary, JSONL output)
  │
  └── BaseApiConnector (abstract)
        ├── OpenRouterConnector  (openrouter.ai/api/v1)
        ├── GroqConnector        (api.groq.com/openai/v1)
        ├── GrokConnector        (api.x.ai/v1)
        └── EmbeddingConnector   (arcana-db:8300, BGE-M3)
```

## Connector Hierarchy

All connectors implement `IConnector` (`src/connectors/interfaces/connector.interface.ts`):

```typescript
interface IConnector {
  readonly name: string;
  execute(req: ConnectorRequest): Promise<ConnectorResponse>;
  getStatus(): ConnectorStatus;
  getCapabilities(): ConnectorCapabilities;
}
```

### `BaseCliConnector`

Abstract class for CLI-backed connectors. Subclass must implement:

- `getBinaryPath()` — resolve binary path
- `buildArgs(req)` — construct CLI args
- `parseOutput(stdout, stderr)` — extract `text`, `usage`, `errorMessage`

Provides:

- Subprocess spawn with CWD isolation (temp dir, prevents CLI from polluting workspace)
- Per-connector `Semaphore` (concurrency cap + queue timeout)
- Per-model circuit breaker (lazy-init via `CircuitBreakerManager`)
- Generic stderr → error classification

### `BaseApiConnector`

Abstract class for HTTP-backed connectors. Subclass must implement:

- `getBaseUrl()` — provider URL
- `buildRequestUrl(req)` — full request URL
- `getHeaders()` — auth + content-type
- `buildRequestBody(req)` — POST body (typically OpenAI-compatible)
- `parseResponse(json)` — extract `text`, `usage`, etc.

Provides:

- Fetch with abort-controller timeout
- Same Semaphore + circuit breaker as CLI base
- HTTP status → error classification (`auth_error` for 401/403, `rate_limited` for 429, etc.)

## Request Flow

```
1. AuthGuard verifies Bearer token (bcrypt against ApiKey table)
2. ConnectorsController validates DTO via Zod
3. ConnectorsService.execute():
   a. Look up connector by name
   b. Acquire concurrency semaphore (queue timeout: 60s default)
   c. Check circuit breaker (closed/half_open → proceed; open → 503 circuit_open)
   d. Connector.execute():
      - CLI: spawn subprocess, parse stdout, classify on exit
      - API: fetch with timeout, parse JSON, classify on HTTP status
   e. JSON sanitization if responseFormat=json_object
   f. Retry on RETRYABLE_ERRORS (max 5 attempts, exponential backoff)
   g. Record metrics (in-memory)
   h. Log to DB (fire-and-forget, doesn't block response)
4. Return ConnectorResponse — HTTP 201 success / 4xx / 5xx mapped via HTTP_ERROR_STATUS
```

## Resilience

### Concurrency (Semaphore)

Per-connector cap configured via `{NAME}_MAX_CONCURRENCY`. When acquired count == cap, new requests queue up to `CONNECTOR_QUEUE_TIMEOUT_MS` (60s default), then return `queue_timeout`.

### Circuit Breaker

Per `connector:model` pair, managed by `CircuitBreakerManager` (`src/core/resilience/circuit-breaker-manager.ts`). States:

- **closed** — normal operation
- **open** — rejects all requests with `circuit_open` until cooldown
- **half_open** — single probe allowed; success → closed, failure → re-open

Triggers:

- Threshold: `CIRCUIT_BREAKER_THRESHOLD` consecutive errors (default 5) → open
- Cooldown: `CIRCUIT_BREAKER_COOLDOWN_MS` (default 30s)
- **Instant open:** `auth_error`, `binary_not_found` (no point retrying immediately)

Reset via admin API: `POST /admin/circuit-breaker/reset` (CONN-0040).

### Retry

In `ConnectorsService`, NOT in connectors themselves. Only retries error types in `RETRYABLE_ERRORS` set:

- `json_parse_error`
- `rate_limited`
- `timeout`
- `server_error`
- `execution_error`

Backoff: `1s, 2s, 4s, 8s` (capped) with jitter. Max attempts: `1 + CONNECTOR_MAX_RETRIES` (default 2).

## Error Classification

`classifyErrorAction()` (`src/core/error-classifier.ts`) maps internal error types to client-facing fields:

| error.type | retryable | recommendation | HTTP status |
|------------|:---------:|----------------|:-----------:|
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

## Configuration

`src/config/env.schema.ts` — single Zod schema for all env vars. Parsed once at boot via `validateEnv`, cached via `getConfig()`. Per-connector overrides follow `{CONNECTOR}_MAX_CONCURRENCY` / `{CONNECTOR}_TIMEOUT_MS` pattern.

## Persistence

- **Postgres** (`arcanada_connector` on arcana-db, Prisma 7 driver-adapter):
  - `ApiKey` — bcrypt-hashed API keys
  - `ExecutionLog` — request/response audit trail (fire-and-forget writes)
- **Redis** (arcana-db:6379, prefix `conn:*`):
  - BullMQ queue `connector-jobs` (async path, used selectively)
  - Future: rate limit counters, distributed circuit breaker state

## Adding a New Connector

1. Create `src/connectors/<name>/`.
2. Implement `<name>.connector.ts` — extend `BaseCliConnector` or `BaseApiConnector`.
3. Implement abstract methods.
4. Create `<name>.module.ts` — register with `ConnectorsService` in `onModuleInit`.
5. Import the new module in `connectors.module.ts`.
6. Add env vars to `src/config/env.schema.ts` (e.g. `<NAME>_API_KEY`, `<NAME>_MAX_CONCURRENCY`).
7. Write `<name>.connector.spec.ts` — mock `fetch` (API) or `child_process.spawn` (CLI).
8. Add page to `docs/connectors/<name>.md`.
9. Update `docs/capability-matrix.md`.
10. Update README connector table.

See CONN-0048 (Grok) and CONN-0047 (Groq) archives for canonical examples — pure additions, no breaking changes.

## See Also

- Per-connector: `docs/connectors/<name>.md`
- Capability matrix: `docs/capability-matrix.md`
- Quick start / API reference: `README.md`
