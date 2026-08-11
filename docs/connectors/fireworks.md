# Fireworks AI connector

The `fireworks` connector uses Fireworks AI's serverless OpenAI-compatible inference API while preserving Fireworks identity and account-qualified model names.

## Configuration and behavior

- `FIREWORKS_API_KEY` supplies `Authorization: Bearer <key>`.
- `FIREWORKS_TIMEOUT_MS` controls request timeout (default 120000 ms).
- `FIREWORKS_MAX_CONCURRENCY` controls local connector concurrency (default 10); it is not a claim about Fireworks account quotas.
- Inference base: `https://api.fireworks.ai/inference/v1`; chat endpoint: `POST /chat/completions`.
- The default fallback identifier is `accounts/fireworks/models/llama-v3p1-8b-instruct`; callers may provide another full model resource name.
- Streaming, tools, vision, JSON mode, and reasoning are model-dependent and are not advertised globally by this connector.
- Chat usage maps prompt and completion tokens; the shared response contract derives total tokens from those two documented fields. Fireworks does not document monetary cost in the chat usage object, so `costUsd` remains zero/unknown under the shared response contract.
- Fireworks serverless rate limits are adaptive by account and model. The connector does not publish static RPM/TPM limits or assume `Retry-After` is present.

## Model discovery boundary

Official management discovery is account-scoped at `GET https://api.fireworks.ai/v1/accounts/{account_id}/models`, using `pageSize`, `pageToken`, and response `nextPageToken`. The shared `BaseApiConnector.refreshModels()` seam is a one-request OpenAI-shaped list and cannot truthfully represent this contract. CONN-0250 therefore keeps a deterministic fallback and performs no boot refresh. It does not invent pagination for an inference `/models` endpoint.

## Errors

The shared connector taxonomy classifies authentication, permission, rate/capacity, timeout, and service errors. Fireworks documents HTTP 400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 504, and 520, but does not specify one fixed error JSON envelope.

## Official sources

- [Querying text models](https://docs.fireworks.ai/guides/querying-text-models)
- [REST API introduction](https://docs.fireworks.ai/api-reference/introduction)
- [Create chat completion](https://docs.fireworks.ai/api-reference/post-chatcompletions)
- [List models](https://docs.fireworks.ai/api-reference/list-models)
- [Inference error codes](https://docs.fireworks.ai/guides/inference-error-codes)
- [Serverless rate limits](https://docs.fireworks.ai/serverless/rate-limits)
- [Serverless overview](https://docs.fireworks.ai/serverless/overview)
