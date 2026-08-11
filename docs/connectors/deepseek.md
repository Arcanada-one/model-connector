# DeepSeek connector

The `deepseek` connector targets DeepSeek's official primary API. It is a distinct provider adapter built on the repository's shared HTTP transport, not an aggregator route.

Configuration:

- `DEEPSEEK_API_KEY`: Bearer token supplied at runtime.
- `DEEPSEEK_BASE_URL`: optional exact compatibility base. Defaults to `https://api.deepseek.com`; `https://api.deepseek.com/v1` is also supported as documented compatibility syntax.

Implemented endpoints are `POST {base}/chat/completions` and fixture-testable model discovery at `GET {base}/models`. Module startup does not perform a model refresh. Non-streaming responses expose final text normally and place `reasoning_content` plus `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` in structured metadata.

Capability flags describe this adapter, not every provider-side feature: streaming, tools, and JSON schema are all `false`. For `deepseek-reasoner`, unsupported sampling parameters are omitted. DeepSeek errors use the standard connector envelope, including `402` as `billing_error` and `429` as `rate_limited`; no undocumented rate-limit headers are assumed.

Official references: [API introduction](https://api-docs.deepseek.com/), [chat completions](https://api-docs.deepseek.com/api/create-chat-completion/), [models](https://api-docs.deepseek.com/api/list-models/), [reasoning model](https://api-docs.deepseek.com/guides/reasoning_model/), [context caching](https://api-docs.deepseek.com/guides/kv_cache/), and [error codes](https://api-docs.deepseek.com/quick_start/error_codes/).
