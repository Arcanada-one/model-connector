# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Notes

- Cost-budget hard cap (HTTP 503 when daily spend ≥ baseline), drift detection, and the multi-provider cascade (Deepgram, AssemblyAI, OpenAI Whisper) ship in a subsequent release along with corresponding env vars and Vault paths.
- Self-hosted Whisper async endpoint (`/v1/speech/stt/async` on a separate BullMQ pipeline) is scoped to a later release and not part of this one.

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
