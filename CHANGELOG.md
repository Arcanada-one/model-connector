# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Catalog accuracy: REPLACE-not-UNION + per-model modality/pricing (CONN-0238)** —
  the deployed catalog diverged from each provider's real `/models` API. Root cause:
  `refreshModels()` cached `static ∪ provider` (UNION), so on a successful live fetch
  stale/phantom static ids survived (grok prod showed 18 = 9 real + 9 phantom;
  openmodel 36 = 34 real + 2 dead `deepseek-r2`/`qwen3-235b`). Fixes:
  - **REPLACE not UNION** — a successful refresh makes the live provider list the
    sole source of truth; the static list is the offline/CI fallback only. Static
    floors trimmed to verified-minimum (openmodel → `deepseek-v4-flash`; grok → the
    real 9; groq → 9 chat). Phantoms structurally impossible.
  - **Per-model modality** — `extractModels()` returns `{id, modality, free, pricing,
    contextWindow, maxOutputTokens}`. groq now SHOWS all 17 (chat + whisper STT +
    orpheus TTS + prompt-guard moderation) with the correct modality instead of
    dropping the non-chat families; grok classifies grok-imagine image/video.
  - **openrouter surfaces all ~340** (26 free) instead of free-only; each model
    carries a `free` flag + pricing + context. Page defaults to free-first via
    `?free=true`.
  - **Real pricing + context** — new `pricing` (`{inputPerMTok, outputPerMTok,
    unit}`, normalised per-1M-tokens), `contextWindow`, `maxOutputTokens` catalog
    fields, populated verbatim from groq/openrouter `/models`. `rateLimits` stays
    `null` (no machine RPM/TPM source; plan-tier numbers never scraped).
  - New modality enum values `video` + `moderation` (Class B additive). Non-chat
    families surfaced via a chat connector are `available:false` with their honest
    sibling-module endpoint (anti-fabrication — not claimed callable via `/execute`).
  - All ids/prices come from live `/models` captures (groq/openrouter live, grok/
    openmodel operator live captures 2026-06-23) — nothing invented.

- **public-surface-lint no longer false-positives on the `BGE-M3` model name
  (CONN-0228)** — the CI gate (`public-surface / public-surface-lint`) was failing
  on `main` because the framework milestone pattern matched the trailing token of
  the public embedding-model name `BGE-M3`, flagging 11 legitimate references
  across `README.md` and `docs/`. This blocked merge of every PR. The repo now
  ships a consumer-scoped `dev-tools/public-surface-forbidden.regex` (wired via the
  workflow's `regex_file` input) whose milestone pattern is tightened so it ignores
  hyphenated identifiers such as `BGE-M3` while still flagging standalone milestone
  leaks. Enforced by `dev-tools/public-surface-forbidden.regex.spec.bats`.

### Added

- **Prometheus surface for speech proxy (CONN-0098)** — new `GET /metrics` endpoint
  (Bearer-protected via the existing `AuthGuard`) exposes two series in the standard
  `text/plain; version=0.0.4` format:
  - `mc_speech_proxy_total{endpoint, status_class}` — counter incremented on every
    response from `/v1/speech/{tts,vad,stt}`, with `endpoint ∈ {tts, vad, stt}` and
    `status_class ∈ {1xx, 2xx, 3xx, 4xx, 5xx}`.
  - `mc_speech_proxy_latency_ms{endpoint}` — histogram with explicit buckets
    `[100, 250, 500, 1000, 2500, 5000, 10000, 30000]` ms, one observation per
    request. Buckets reflect STT/TTS p50/p95/p99 from the TRANS-0035 baseline and
    may be refined once PROD scrape data is in.

  Internals live in a dedicated `SpeechMetricsService` + `SpeechMetricsModule`
  with a private `prom-client` `Registry`, kept strictly orthogonal to the
  existing connector-keyed `MetricsService` JSON aggregation served at
  `/health/metrics` (no schema or call-site changes there).

- **Speech-to-text routing — Phase 1a (Groq Whisper sync)**:
  - `POST /v1/speech/stt` is now a live transcription endpoint backed by Groq Whisper (`whisper-large-v3` default). Multipart upload (`file`), optional `language`/`model`/`prompt`/`temperature` form fields, 25 MB audio cap, BCP-47 language hint, returns
    `{transcription, model, provider, language, latency_ms, cost_usd, audio_duration_seconds, fallback_count, request_id}`.
  - New abstract `BaseSttConnector` and concrete `GroqSttConnector` with per-provider concurrency cap and circuit breaker. 4xx responses (auth/payload/MIME) propagate to caller but do **not** trip the breaker — only `5xx`, `408`, `429`, network and timeout errors count, matching the resilience-pattern default for HTTP integrations.
  - `SttRouterService` iterates `STT_PROVIDERS_ORDER` (Phase 1a: `groq` only), persists one `SttTranscription` audit row per request (success and failure paths), emits a soft pino warning when daily Groq spend crosses 80% of `STT_DAILY_BUDGET_USD`. No hard 503 budget cut in Phase 1a — that lands in Phase 1b alongside the multi-provider cascade.
  - `MetricsService.recordStt()` + `getAllStt()` — per `provider:model` counters for requests / success / errors / cost / latency / audio duration.
- **Multipart parser** registered at bootstrap via `@fastify/multipart@^9`. `fileSize` limit honours `STT_MAX_AUDIO_BYTES` so oversize uploads are rejected before fully buffering.
- **New env vars** (`src/config/env.schema.ts`):
  - `STT_MULTI_PROVIDER` (default `false`) — Phase 1a single-provider gate; Phase 1b flips to cascade.
  - `STT_PROVIDERS_ORDER` (default `groq`) — comma-separated priority list.
  - `STT_PROVIDER_GROQ_ENABLED` (default `true`).
  - `STT_GROQ_API_KEY` (optional; falls back to existing `GROQ_API_KEY` when unset).
  - `STT_GROQ_MODEL` (default `whisper-large-v3`).
  - `STT_GROQ_PRICE_USD_PER_MIN` (default `0.00185`).
  - `STT_GROQ_TIMEOUT_MS` (default `60000`).
  - `STT_GROQ_MAX_CONCURRENCY` (default `10`).
  - `STT_MAX_AUDIO_BYTES` (default `26214400` ≈ 25 MiB).
  - `STT_DAILY_BUDGET_USD` (default `10`).
  - `STT_COST_WARN_THRESHOLD_PCT` (default `0.8`).
- **Prisma migration** `20260516000000_conn_0102_stt_transcription` — new `SttTranscription` table (FK → `ApiKey`, indexes on `(provider, createdAt)`, `(apiKeyId, createdAt)`, `status`). PK is app-side UUID v7 to keep inserts time-sortable.
- **Env-flag boolean parser** — internal helper that treats `false` / `0` / `no` / empty as `false` for `STT_MULTI_PROVIDER` and `STT_PROVIDER_GROQ_ENABLED`. (Zod's `z.coerce.boolean()` coerces the literal string `"false"` to `true`; explicit parsing avoids the foot-gun on these flags.)
- New integration spec (`stt-pilot.integration.spec.ts`) exercises the full router → connector → Groq path via MSW.
- 32 new vitest specs across `src/speech/stt/`, `src/speech/dto/stt-*`, and `src/metrics/` cover DTO validation, error classes, base/Groq connectors, router persistence + cost warn, controller envelope mapping, and metrics buckets.

### Changed

- `POST /v1/speech/stt` no longer returns the previous 501 stub envelope. The `stt_not_yet_routed` error code is retired.
- `SpeechErrorCode` adds `stt_audio_too_large`, `stt_unsupported_mime`, `stt_validation_error`, `stt_provider_failed`, `stt_all_providers_exhausted`, `stt_no_provider_configured`.
- `POST /v1/speech/tts` and `POST /v1/speech/vad` keep their existing proxy semantics unchanged.

- **Speech-to-text — multi-provider cascade (Deepgram, AssemblyAI, OpenAI)**:
  - Three new connectors: `DeepgramSttConnector` (`nova-3`, raw-body POST, `Authorization: Token`), `AssemblyAiSttConnector` (`universal-2`, two-step upload → submit → poll), `OpenAiSttConnector` (`gpt-4o-mini-transcribe`, multipart `response_format=json` — `verbose_json` is rejected for this model family).
  - Cascade fallback: when `STT_MULTI_PROVIDER=true`, retryable `SttProviderError` triggers the next provider in `STT_PROVIDERS_ORDER`. `fallback_count` in the response envelope records the number of hops before success.
  - Hard daily-cost circuit breaker: when aggregated `costUsd` for the UTC day reaches `STT_DAILY_BUDGET_USD`, the router returns `HTTP 503 stt_budget_exhausted` **before** any outbound HTTP fires. Soft-warn at 80% threshold remains as a `pino.warn` log.
  - Zod-based drift detection: each provider has a registered response schema; mismatch is surfaced as retryable `SttProviderError(type: 'drift')` and persisted with `driftStatus='schema_fail'` for audit.
- **`SttBudgetExhaustedError`** — standalone (NOT extends `SttProviderError`) so cascade-catch in the router does not retry it. Maps to `HTTP 503` with `details.daily_cost_usd` and `details.budget_usd`.
- **Audit columns** — `SttTranscription.fallbackCount` (Int, default 0) and `SttTranscription.driftStatus` (`schema_pass` / `schema_fail` / null) added via Prisma migration `20260516170000_conn_0103_stt_drift_and_fallback`.
- New env vars (all default disabled / fail-closed):
  - `STT_PROVIDER_DEEPGRAM_ENABLED`, `STT_DEEPGRAM_API_KEY`, `STT_DEEPGRAM_MODEL`, `STT_DEEPGRAM_PRICE_USD_PER_MIN`, `STT_DEEPGRAM_TIMEOUT_MS`, `STT_DEEPGRAM_MAX_CONCURRENCY`.
  - `STT_PROVIDER_ASSEMBLYAI_ENABLED`, `STT_ASSEMBLYAI_API_KEY`, `STT_ASSEMBLYAI_MODEL`, `STT_ASSEMBLYAI_PRICE_USD_PER_MIN`, `STT_ASSEMBLYAI_TIMEOUT_MS`, `STT_ASSEMBLYAI_POLL_INTERVAL_MS`, `STT_ASSEMBLYAI_MAX_CONCURRENCY`.
  - `STT_PROVIDER_OPENAI_ENABLED`, `STT_OPENAI_API_KEY`, `STT_OPENAI_MODEL`, `STT_OPENAI_PRICE_USD_PER_MIN`, `STT_OPENAI_TIMEOUT_MS`, `STT_OPENAI_MAX_CONCURRENCY`.

### Changed

- `POST /v1/speech/stt` no longer returns the previous 501 stub envelope. The `stt_not_yet_routed` error code is retired.
- `SpeechErrorCode` adds `stt_audio_too_large`, `stt_unsupported_mime`, `stt_validation_error`, `stt_provider_failed`, `stt_all_providers_exhausted`, `stt_no_provider_configured`, `stt_budget_exhausted`.
- `SpeechErrorEnvelope` gains an optional `details` payload (used by `stt_budget_exhausted` for `daily_cost_usd` + `budget_usd`, and by `stt_all_providers_exhausted` for `providers_tried`).
- `POST /v1/speech/tts` and `POST /v1/speech/vad` keep their existing proxy semantics unchanged.
- `BaseSttConnector.buildRequestBody()` is the new abstract for connectors with raw-body payloads (Deepgram, AssemblyAI upload). `buildMultipartBody()` is preserved for `FormData` providers (Groq, OpenAI).
- **STT remediation (CONN-0103 round 2)**:
  - `MetricsService` exposes `incrementSttSchemaFail(provider)` + `getSttSchemaFailCounts()` — named drift counter `stt_response_schema_fail_total{provider}` surface. Router increments on every Zod schema-fail outcome.
  - `SttBudgetExhaustedError` carries `providersTried: string[]` (always `[]` at the hard-CB gate). The 503 `stt_budget_exhausted` envelope `details` now exposes `providers_tried: []` — symmetric with `stt_all_providers_exhausted` so clients read the field unconditionally.
  - `envSchema` enforces a `superRefine` check: when `STT_PROVIDER_{NAME}_ENABLED=true`, the matching `STT_{NAME}_API_KEY` (or legacy `GROQ_API_KEY` fallback for Groq) MUST be set. Fail-closed at boot via `validateEnv()` instead of runtime fail-open on first request.

### Notes

- Self-hosted Whisper async endpoint (`/v1/speech/stt/async` on a separate BullMQ pipeline) is scoped to a later release and not part of this one.
- All three new providers default to disabled (`STT_PROVIDER_*_ENABLED=false`). The operator flips them after provisioning real API keys in Vault path `arcanada/prod/env/model-connector/STT_*`. Until then the surface continues to honour the single-Groq path from the previous release.

## [0.3.0] - 2026-05-13

### Added

- **First-party client SDKs**:
  - TypeScript — [`@arcanada/model-connector-sdk`](https://www.npmjs.com/package/@arcanada/model-connector-sdk) under `packages/sdk-ts/`. Dual ESM + CJS via `tsup`. Node >= 20. Zero runtime dependencies (uses global `fetch`).
  - Python — [`arcanada-model-connector`](https://pypi.org/project/arcanada-model-connector/) under `packages/sdk-python/`. Sync `Client` + `AsyncClient` via `httpx`. Pydantic v2 models. Python >= 3.10.
  - Both SDKs expose the full `/execute` schema including `output_format`, `schema`, and the `repair_report` envelope introduced in v0.2.0.
  - Typed error hierarchy: `ConnectorError`, `GuardExhaustedError`, `TimeoutError`, plus `NetworkError` (Python) / `NodeVersionError` (TS).
  - `Bearer` tokens and `Authorization` headers are redacted from error causes before throwing.
- README top-level `## Client SDKs` section with install + quick-start per language.
- `docs/sdk-typescript.md` and `docs/sdk-python.md` Diataxis how-to guides.
- `.github/workflows/publish-sdks.yml` — tag-triggered (`sdk-v*`) publish workflow. PyPI via OIDC trusted-publisher; npm via OIDC provenance with granular-token fallback.
- `pnpm-workspace.yaml` — workspace root declaration (server stays `private: true`; only `packages/*` are publishable).

### Notes

- SDK packages ship at `0.1.0` initial release, decoupled from server semver. Use SDK tags `sdk-v*` for releases.
- Server schema is the source of truth; SDK types are 1:1 wire mirrors and use `extra='allow'` (Python) / pass-through interfaces (TS) to forward-compat with new fields.

## [0.2.0] - 2026-05-12

### Added

- **Output-guard middleware** on `POST /execute`:
  - New request fields `output_format` (`json` / `yaml` / `toml` / `python` / `auto`) and `schema` (JSON Schema, ≤32 KiB).
  - New response envelope `repair_report` with `strategies_applied[]`, `retries`, `final_valid`, `pass` (`native` / `guarded` / `failed`), `error`.
  - Cross-connector structured-output enforcement: native pass → deterministic repair strategies (fence-strip, trailing-comma, quote-fix, balanced-bracket) → LLM retry pass with corrective prompt.
  - Configurable via `OUTPUT_GUARD_ENABLED` (default `true`), `OUTPUT_GUARD_MAX_RETRIES` (default `3`), `OUTPUT_GUARD_TIMEOUT_MS` (default `30000`).
  - Full how-to guide: [`docs/how-to/use-output-guard.md`](docs/how-to/use-output-guard.md).
- README sections: **Output Guard** (after **JSON Mode**); `repair_report` table under **Response Schema**.

## [0.1.0] - Initial release

### Added

- `POST /execute` endpoint with connector dispatch (Claude Code, Cursor, Gemini, Codex, OpenRouter, Groq, Grok, Embedding).
- API-key authentication, per-key rate limiting, admin token for key management.
- Per-connector concurrency limits + global queue with `queueWaitMs` surfacing.
- Auto-retry on transient errors (`CONNECTOR_MAX_RETRIES`), circuit breaker per connector.
- JSON Mode (`responseFormat: { type: "json_object" }`, `jsonSchema` for Claude Code).
- JSON sanitisation pass on CLI-connector output (best-effort, pre-output-guard).

[Unreleased]: https://github.com/Arcanada-one/model-connector/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Arcanada-one/model-connector/releases/tag/v0.3.0
[0.2.0]: https://github.com/Arcanada-one/model-connector/releases/tag/v0.2.0
[0.1.0]: https://github.com/Arcanada-one/model-connector/releases/tag/v0.1.0
