# Cloudflare Workers AI

`cloudflare-workers-ai` uses Cloudflare's native, account-scoped REST API. It is
not an OpenAI compatibility profile.

## Configuration

Set `CLOUDFLARE_WORKERS_AI_ACCOUNT_ID` and `CLOUDFLARE_WORKERS_AI_API_TOKEN`.
The token is sent as `Authorization: Bearer` and needs Workers AI Read or Write.
`CLOUDFLARE_WORKERS_AI_BASE_URL` defaults to
`https://api.cloudflare.com/client/v4`; the timeout defaults to 120 seconds.

Inference uses:

```text
POST /accounts/{account_id}/ai/run/{model_name}
```

The model ID is part of the URL. The JSON body uses Cloudflare's native
`messages`, generation controls, and optional `response_format`. Responses are
read from the Cloudflare v4 envelope (`result.response` and `result.usage`).

The connector is intentionally limited to non-streaming text generation. It
does not advertise tools and does not call Cloudflare during application boot.

## Catalog and limits

Cloudflare's authoritative account catalog is
`GET /accounts/{account_id}/ai/models/search`. Its official API documents
`page` and `per_page`, plus task/author/deprecation filters. That catalog spans
many task families, so it is not boot-imported into this chat connector. The
connector instead exposes a small cited offline floor of text-generation IDs.

Cloudflare documents a default text-generation limit of 300 requests/minute,
with model-specific exceptions, and provider errors including `3036` (daily
neuron allocation exhausted) and `3040` (capacity), both HTTP 429. Error codes
and messages are retained in Model Connector errors.

Official references:

- https://developers.cloudflare.com/api/resources/ai/methods/run/
- https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list
- https://developers.cloudflare.com/workers-ai/platform/errors/
- https://developers.cloudflare.com/workers-ai/platform/limits/
