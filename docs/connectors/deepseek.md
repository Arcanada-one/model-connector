# DeepSeek connector

The `deepseek` connector targets DeepSeek's official primary API. It is a distinct provider adapter built on the repository's shared HTTP transport, not an aggregator route.

Configuration:

- `DEEPSEEK_API_KEY`: Bearer token supplied at runtime.
- `DEEPSEEK_BASE_URL`: optional exact compatibility base. Defaults to `https://api.deepseek.com`; `https://api.deepseek.com/v1` is also supported as documented compatibility syntax.

Implemented endpoints are `POST {base}/chat/completions` and fixture-testable model discovery at `GET {base}/models`. Module startup does not perform a model refresh. Non-streaming responses expose final text normally and place `reasoning_content` plus `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` in structured metadata.

Capability flags describe this adapter, not every provider-side feature: streaming, tools, and JSON schema are all `false`. Sampling parameters (`temperature`, `top_p`, `presence_penalty`, `frequency_penalty`) are forwarded for every model. DeepSeek errors use the standard connector envelope, including `402` as `billing_error` and `429` as `rate_limited`; no undocumented rate-limit headers are assumed.

## Models and retired ids (A2-209)

Measured against the live API on 2026-09-23. `GET /models` lists exactly two ids, and these are the two the connector advertises and prices:

| Model | Notes |
|-------|-------|
| `deepseek-flash` | DeepSeek-V4.1-Flash. The connector default. Reasoning is on by default (`effort` levels `low`/`high`/`max`, default `high` — there is no "off"). |
| `deepseek-v4-pro` | DeepSeek-V4-Pro. |

Three further ids are **not** in the listing but are still accepted by the provider, which serves them under `deepseek-flash`. Measured with one prompt and `max_tokens: 200`:

| Requested | Served as | Reasoning |
|-----------|-----------|-----------|
| `deepseek-chat` | `deepseek-flash` | **no** |
| `deepseek-reasoner` | `deepseek-flash` | yes |
| `deepseek-v4-flash` | `deepseek-flash` | yes |

An id outside all of the above is refused by the provider with `validation_error`.

Two consequences worth knowing:

- **Retired ids keep working.** The connector passes them through verbatim and does not resolve them itself, because the three are not equivalent — `deepseek-chat` is the only route to non-reasoning flash, and rewriting it locally would silently turn a cheap non-reasoning request into a billed reasoning one.
- **A substitution is now visible.** When the provider serves a request under an id other than the one asked for, the response carries `modelSubstituted: { requested, served }` alongside `model` (which still reports what actually served the request). The field is emitted only from the provider's own echo, so it is a measurement, not a lookup; it is absent when the caller named no model, when the ids match, or when the provider echoed nothing.

> The connector default changed from `deepseek-chat` to `deepseek-flash` in A2-209. `deepseek-chat` was retired by DeepSeek on 2026-07-24 and survives only as an undocumented alias. Because the old default was reasoning-**off** and the new one is reasoning-**on**, a caller that names no model now spends reasoning tokens (billed at the output rate) it did not spend before.

Official references: [API introduction](https://api-docs.deepseek.com/), [chat completions](https://api-docs.deepseek.com/api/create-chat-completion/), [models](https://api-docs.deepseek.com/api/list-models/), [reasoning model](https://api-docs.deepseek.com/guides/reasoning_model/), [context caching](https://api-docs.deepseek.com/guides/kv_cache/), and [error codes](https://api-docs.deepseek.com/quick_start/error_codes/).
