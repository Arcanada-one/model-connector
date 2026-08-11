# Perplexity Sonar Connector

The `perplexity` connector uses Perplexity's native Sonar API and preserves the
provider response envelope in `ConnectorResponse.structured`, including
`citations`, `search_results`, `images`, `related_questions`, and native `usage`.

| Setting | Value |
| --- | --- |
| Endpoint | `POST https://api.perplexity.ai/v1/sonar` |
| Authentication | `Authorization: Bearer $PERPLEXITY_API_KEY` |
| Default model | `sonar` |
| Models | `sonar`, `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research` |
| Timeout | 120 seconds (`PERPLEXITY_TIMEOUT_MS`) |
| Concurrency | 10 (`PERPLEXITY_MAX_CONCURRENCY`) |

## Request options

Pass provider-specific options through `extra`. The connector forwards only the
current documented names: `max_tokens`, `stream`, `stop`, `temperature`, `top_p`,
`response_format`, `web_search_options`, `search_mode`, `return_images`,
`return_related_questions`, `enable_search_classifier`, `disable_search`,
domain/language/recency/date filters, image format/domain filters, `stream_mode`,
`reasoning_effort`, and `language_preference`. Perplexity documents that option
support can vary by model.

`response_format` supports the official text and JSON Schema shapes. The connector
does not translate the generic Model Connector `json_object` shape into an
undocumented Sonar value.

## Errors and rates

- 401 is `auth_error`; 403 is `permission_error`.
- 422 is `validation_error`, with the documented `detail[]` retained in
  `error.details`.
- 429 is `rate_limited`; a numeric `Retry-After` is exposed in milliseconds when
  the response supplies it.
- 5xx responses are `server_error`; other bodies remain defensive raw messages.

Sonar rates are account-tier and model dependent (currently 50–4,000 RPM for
Sonar/Sonar Pro/Sonar Reasoning Pro and 5–100 RPM for Sonar Deep Research). No
single RPM is hard-coded. Apply backoff with jitter upstream after a 429.

## Discovery boundary

The official `GET /v1/models` endpoint lists models for `POST /v1/agent`; it is not
Sonar discovery and documents no pagination. This connector intentionally uses the
four models enumerated by the Sonar endpoint and performs no boot-time refresh.

## References

- https://docs.perplexity.ai/api-reference/sonar-post
- https://docs.perplexity.ai/docs/sonar/models
- https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers
- https://docs.perplexity.ai/api-reference/models-get
