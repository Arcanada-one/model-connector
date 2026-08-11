# Together connector reference

The `together` connector is a distinct provider adapter built on the shared HTTP execution base. It targets `https://api.together.xyz/v1`, sends `Authorization: Bearer <token>`, posts chat requests to `/chat/completions`, and maps `usage.prompt_tokens` and `usage.completion_tokens` into Model Connector usage.

Model discovery is available only by explicitly calling `refreshModels()`. The application does not refresh Together models during boot. Together documents `GET /v1/models` as returning the complete JSON array and documents no cursor, page, offset, or continuation parameter; the adapter therefore performs exactly one request and does not invent pagination. Only entries whose `type` is `chat` enter this chat connector's catalog.

Capability flags describe this implementation, not every feature offered by Together: streaming, JSON Schema, and tools are `false`. Provider rate limits are dynamic per organization and model. Together documents `429 Too Many Requests` above the dynamic limit, `503 Service Unavailable` for capacity failures at or below the dynamic rate, and `x-ratelimit-reset` as the suggested retry interval. The shared base normalizes HTTP 429 to `rate_limited` and 5xx responses to `server_error`; this adapter does not claim to expose the response header because the shared response contract has no header field.

Official sources (reviewed 2026-07-11):

- https://docs.together.ai/docs/quickstart
- https://docs.together.ai/reference/chat-completions-1
- https://docs.together.ai/reference/models
- https://docs.together.ai/docs/serverless/rate-limits
- https://docs.together.ai/docs/error-codes
