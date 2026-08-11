# Gemini Developer API connector

`gemini-api` is Model Connector's native REST adapter for the Google Gemini Developer API. It is separate from:

- `gemini`, which runs the Gemini CLI with Google OAuth;
- Vertex AI image-generation code, which uses Google Cloud project and service-account semantics.

## Supported contract

- `models.generateContent` text requests;
- system instructions;
- JSON response MIME type and JSON Schema;
- generation controls: temperature, top-p, top-k, max output tokens, and stop sequences;
- generated text and token-usage normalization;
- generate-capable model discovery through `models.list`.

Streaming, Interactions, Live API, Files API, media upload, embeddings, and automatic tool execution are not part of this connector.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | unset | API credential sent only as `x-goog-api-key` |
| `GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | Official Gemini Developer API base URL |
| `GEMINI_API_TIMEOUT_MS` | `120000` | Request timeout |
| `GEMINI_API_MAX_CONCURRENCY` | `10` | Connector concurrency limit |

Never commit an API key. The CONN-0242 suite uses sentinel values and mocked fetch responses only.

## Primary specifications

- https://ai.google.dev/api/generate-content
- https://ai.google.dev/api/models
- https://ai.google.dev/gemini-api/docs/api-key
- https://ai.google.dev/gemini-api/docs/structured-output
