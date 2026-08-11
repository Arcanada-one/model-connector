# Mistral connector

Native API connector for Mistral AI. It is registered as `mistral`; it is not a generic OpenAI-compatible profile.

## Configuration

Set `MISTRAL_API_KEY`. Optional settings are `MISTRAL_TIMEOUT_MS` (default 120000) and `MISTRAL_MAX_CONCURRENCY` (default 10). Requests use Bearer authentication against `https://api.mistral.ai/v1`.

## API behavior

The connector sends non-streaming text chat to `/chat/completions` and refreshes chat-capable models from `/models`. A small alias list is retained only as an offline fallback; a successful model refresh replaces it. Mistral model cards supply context length and vision capability metadata.

Mistral's API supports streaming, tools and other native fields. The current Model Connector adapter advertises only what its shared execution contract exposes: non-streaming text chat and JSON response mode. It does not claim tool execution or streaming support.

HTTP 401/403, 400/422, 429 and 5xx responses use Model Connector's standard auth, validation, rate-limit and server error taxonomy. HTTP 402 is retained as a generic account/payment HTTP error. The connector does not add its own retry loop.

Tests use synthetic fixtures and mocked HTTP only. Official references: [Chat API](https://docs.mistral.ai/api), [Models API](https://docs.mistral.ai/api/endpoint/models), and [developer quickstart](https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request).
