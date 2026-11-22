# Image Generation Connector

Unified image generation API for the Model Connector service.

## Overview

The image generation connector routes generation requests to one of three providers:

- **Vertex AI (Imagen 4 family)** — Google Cloud, 4 model tiers, SynthID watermark
- **Replicate (FLUX.1 Pro)** — no watermark, premium quality
- **OpenAI (GPT Image 2.5 Sunburst)** — 3 quality tiers, strict content moderation

All providers require Vault credentials at `arcanada/prod/env/model-connector-{vertex,replicate,openai-images}`.
Missing credentials return HTTP 503 with `code: PROVIDER_NOT_PROVISIONED` — not a crash.

---

## Capability Matrix

| Model ID                               | Provider      | Tier    | Price/img   | Latency p95 | Async? | Watermark | Notes                                 |
| -------------------------------------- | ------------- | ------- | ----------- | ----------- | ------ | --------- | ------------------------------------- |
| `vertex:nano-banana`                   | vertex        | cheap   | $0.039      | 8s          | no     | optional  | Gemini 2.5 Flash Image                |
| `vertex:imagen-4-fast`                 | vertex        | mid     | $0.020      | 6s          | no     | optional  | Imagen 4 Fast, 5 aspect ratios        |
| `vertex:imagen-4`                      | vertex        | mid     | $0.040      | 15s         | no     | optional  | Imagen 4 Standard, up to 2816px       |
| `vertex:imagen-4-ultra`                | vertex        | premium | $0.070      | 45s         | yes    | optional  | Imagen 4 Ultra, highest quality       |
| `replicate:flux-pro`                   | replicate     | premium | $0.040      | 30s         | yes    | never     | FLUX.1 Pro, no watermark              |
| `openai:gpt-image-2.5-sunburst-low`    | openai-images | mid     | usage-based | 10s         | no     | never     | GPT Image 2.5 Sunburst low quality    |
| `openai:gpt-image-2.5-sunburst-medium` | openai-images | mid     | usage-based | 20s         | no     | never     | GPT Image 2.5 Sunburst medium quality |
| `openai:gpt-image-2.5-sunburst-high`   | openai-images | premium | usage-based | 60s         | yes    | never     | GPT Image 2.5 Sunburst high quality   |

OpenAI costs are calculated from the API response token usage when present. The router uses a conservative $0.25 per-image estimate for preflight budgeting; it is not a billing quote. Other prices are USD snapshots; verify provider pricing before production billing.

OpenAI shut down `gpt-image-1` on 2026-10-23. Requests pinned to `gpt-image-1` or an `openai:gpt-image-1-*` model ID receive HTTP 410 with `code: MODEL_RETIRED` and the supported Sunburst model IDs. The official deprecations page lists both GPT Image 2.5 Sunburst and Flare as replacements, so the service does not silently treat the old ID as an alias. Sunburst is selected for the premium route because its model page highlights editing precision.

### TypeScript model ID contracts

The existing exported `ModelId` is retained unchanged as the deprecated v1 type contract so existing TypeScript consumers do not receive a breaking union change. New code should use the additive `ModelIdV2` contract, which lists the currently routed model IDs, including GPT Image 2.5 Sunburst. The HTTP request's `model` field remains a string; runtime requests using a retired GPT Image 1 value are rejected with the 410 response above. The vendored contract verifier treats adding a contract as compatible, while removals and union widenings on an existing bidirectional contract are breaking or not measurable. This versioned type addition therefore preserves the old type contract and declares the current set separately.

GPT Image models return base64 image data; they do not support the legacy `response_format=url` parameter. The connector requests PNG with `output_format` and returns a `data:image/png;base64,...` URI, including when the API's `outputFormat` field is `url`. GPT Image 2.5 supports `low`, `medium`, `high`, `xhigh`, `max`, and `auto`; this connector currently exposes low, medium, and high. Arbitrary dimensions must be divisible by 16 with an aspect ratio from 1:3 through 3:1. The provider's standard sizes are 1024×1024, 1536×1024, and 1024×1536.

Official references checked 2026-11-22:

- [Deprecations](https://developers.openai.com/api/docs/deprecations) — shutdown date, listed replacements, and notice date.
- [GPT Image 1 model](https://developers.openai.com/api/docs/models/gpt-image-1) — retired model status and replacement recommendation.
- [GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) — model capabilities and quality settings.
- [Image API reference](https://developers.openai.com/api/reference/resources/images/methods/generate) — dimensions, formats, response shape, and usage fields.
- [Pricing](https://developers.openai.com/api/docs/pricing) — token rates for GPT Image 2.5.

---

## API

### POST /images/generate

Generate one or more images. Requires Bearer auth (API key).

**Request body:**

```json
{
  "tier": "mid",
  "prompt": "a cat reading a book in a library",
  "quality": "medium",
  "count": 1,
  "outputFormat": "url",
  "outputAsync": "auto",
  "aspectRatio": "16:9",
  "negativePrompt": "blurry, low quality",
  "seed": 42,
  "model": "vertex:imagen-4-fast"
}
```

| Field            | Type                      | Required | Description                                                                                                              |
| ---------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tier`           | `cheap \| mid \| premium` | yes      | Quality/cost tier for routing                                                                                            |
| `prompt`         | string                    | yes      | Generation prompt (max 8000 chars for premium)                                                                           |
| `quality`        | `low \| medium \| high`   | no       | Provider quality hint (default: medium)                                                                                  |
| `count`          | integer 1–4               | no       | Number of images (default: 1)                                                                                            |
| `outputFormat`   | `url \| inline_base64`    | no       | Caller-facing delivery preference (default: url); OpenAI GPT Image responses are returned as base64 data URIs either way |
| `outputAsync`    | `auto \| force \| never`  | no       | Async mode override (default: auto)                                                                                      |
| `aspectRatio`    | string                    | no       | e.g. `1:1`, `16:9`, `9:16`, `4:3`                                                                                        |
| `negativePrompt` | string                    | no       | Negative prompt (Vertex only)                                                                                            |
| `seed`           | integer                   | no       | Reproducibility seed (Vertex/Replicate)                                                                                  |
| `model`          | string                    | no       | Pin to specific model, bypass tier routing                                                                               |
| `width`          | integer                   | no       | Output width in pixels                                                                                                   |
| `height`         | integer                   | no       | Output height in pixels                                                                                                  |

**Sync response (200):**

```json
{
  "requestId": "01926abc-...",
  "status": "completed",
  "urls": ["https://...r2.cloudflarestorage.com/images/2026/05/08/..."],
  "costUsd": 0.02,
  "latencyMs": 3200,
  "routing": {
    "chosenProvider": "vertex",
    "chosenModel": "vertex:imagen-4-fast",
    "fallbackUsed": false,
    "reason": "vertex model imagen-4-fast",
    "costUsd": 0.02
  }
}
```

**Async response (201 Created):**

```json
{
  "requestId": "01926abc-...",
  "status": "queued",
  "jobId": "42",
  "pollUrl": "/jobs/01926abc-...",
  "costUsd": 0,
  "routing": { ... }
}
```

### GET /jobs/:imageGenerationId

Poll async job status. Returns ownership-scoped result (only for the API key that created the job).

**Response:**

```json
{
  "id": "01926abc-...",
  "status": "processing | completed | failed",
  "resultUrl": "https://...r2.cloudflarestorage.com/...",
  "costUsd": 0.07
}
```

### GET /connectors/image/capabilities

Returns the full capability matrix (no auth required).

---

## curl Examples

```bash
# Sync generation — mid tier, auto routing
curl -X POST https://connector.arcanada.one/images/generate \
  -H "Authorization: Bearer $MC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "mid",
    "prompt": "a red cube on white background, studio lighting",
    "quality": "medium",
    "count": 1,
    "outputFormat": "url",
    "outputAsync": "never"
  }'

# Premium async — pin to Imagen 4 Ultra
curl -X POST https://connector.arcanada.one/images/generate \
  -H "Authorization: Bearer $MC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "premium",
    "prompt": "cinematic photo of a mountain at sunrise, 8K",
    "quality": "high",
    "count": 1,
    "outputFormat": "url",
    "outputAsync": "auto",
    "model": "vertex:imagen-4-ultra",
    "aspectRatio": "16:9"
  }'

# Poll async job
curl https://connector.arcanada.one/jobs/01926abc-... \
  -H "Authorization: Bearer $MC_KEY"

# Get capability matrix (no auth)
curl https://connector.arcanada.one/connectors/image/capabilities
```

---

## Error Codes

| HTTP | `code`                     | Description                                                                  |
| ---- | -------------------------- | ---------------------------------------------------------------------------- |
| 503  | `PROVIDER_NOT_PROVISIONED` | Vault credentials are PLACEHOLDER or missing. All tier providers exhausted.  |
| 503  | `circuit_open`             | Provider circuit breaker is open (5+ consecutive failures). Retry after 30s. |
| 400  | `validation_error`         | Request body failed Zod validation.                                          |
| 401  | (no code)                  | Missing or invalid Bearer token.                                             |
| 429  | `rate_limited`             | Provider rate limit exceeded. Retryable.                                     |

---

## Routing Logic

1. `tier` → TIER_MAP lookup → primary model
2. If primary model's circuit breaker is open → next model in tier list (fallback)
3. If `model` pin provided → skip tier routing, use pinned model directly
4. If model throws `ProviderNotProvisionedError` → try next provider in tier (`routeExcluding`)
5. If all tier providers exhausted → 503 with aggregate error

Routing decision is persisted in `ImageGeneration.metadata` as JSON for audit.

---

## Storage

Generated images are uploaded to Cloudflare R2 (bucket: `arcanada-images`).
URLs are presigned with configurable TTL (default 24h, max 7 days).

Requires provisioned R2 credentials in Vault:

```
arcanada/prod/env/model-connector-r2:
  account_id, access_key_id, secret_access_key, bucket, endpoint
```

---

## Async Threshold

Models are automatically routed async if `latencyP95Ms >= asyncThresholdMs`:

- `vertex:imagen-4-ultra` — asyncThresholdMs: 45 000ms → always async
- `replicate:flux-pro` — asyncThresholdMs: 30 000ms → always async
- `openai:gpt-image-2.5-sunburst-high` — asyncThresholdMs: 60 000ms → always async

Override with `outputAsync: "never"` (sync; risk of Cloudflare 524 on long jobs) or `"force"` (force async for any model).

---

## Deployment Notes

- `ImageGeneration` table migration required on first PROD deploy.
- DB: `arcanada_connector` on arcana-db via Tailscale.
- All providers fail-soft on PLACEHOLDER creds — service boots normally, returns 503 per-request.
