# OpenAI connector

The `openai` connector uses OpenAI's native, non-streaming Responses API at
`POST /v1/responses`. It maps Model Connector prompts to `input`, system prompts
to `instructions`, and JSON schemas to the Responses API `text.format` field.

## Configuration

- `OPENAI_API_KEY` — API key used as a Bearer token. The same variable is already
  used by the OpenAI image connector.
- `OPENAI_BASE_URL` — API origin; defaults to `https://api.openai.com`.
- `OPENAI_TIMEOUT_MS` — request timeout; defaults to 120 seconds.
- `OPENAI_MAX_CONCURRENCY` — concurrent request limit; defaults to 10.

Model discovery uses `GET /v1/models`. The static model list remains available
when discovery fails. Automated tests use local fixtures derived from the official
API schemas and never call OpenAI.

## Current limits

Streaming and tool execution are not exposed because the shared connector
interface has no streaming/event or native tool-call response contract.
