# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Speech proxy endpoints** (TRANS-0035, branch `trans-0035-speech-proxy`):
  - `POST /v1/speech/tts` — proxy to Transcribator API SpeechModule (`api.transcribator.com/v1/speech/tts`). Streams `audio/wav` from upstream Silero TTS. Inherits global `AuthGuard` (Bearer API key).
  - `POST /v1/speech/vad` — pass-through to upstream `/v1/speech/vad` (currently returns 501 until TRANS-0036 lands Silero VAD v6).
  - `POST /v1/speech/stt` — synchronous 501 stub (`error_code: stt_not_yet_routed`, tracking TRANS-0037). Full routing decision deferred to Pilot 1 (`Transcribator Bot STT rewire`).
  - `TranscribatorProxy` — native `fetch` client with `AbortSignal.timeout(SPEECH_PROXY_TIMEOUT_MS)`, single retry on 502/503/504 + 250 ms backoff, header allowlist (`content-type`, `content-length`, `retry-after`, `x-speech-backend`, `x-speech-model-version`, `x-request-id`), Authorization stripped from client-supplied headers.
  - 30 new vitest specs (DTOs ×15 / Proxy ×11 / Service ×4) — total `pnpm test` 50 files / 517 tests green.
- New env vars (`src/config/env.schema.ts`):
  - `TRANSCRIBATOR_API_URL` (default `http://localhost:3700`).
  - `SPEECH_INTERNAL_TOKEN` (optional, min 16 chars).
  - `SPEECH_PROXY_TIMEOUT_MS` (default 30000).

### Notes

- License-aware routing (Silero free vs external paid) and kill switch `SPEECH_BACKEND_ENABLED` live in Transcribator API — Connector is agnostic to backend selection.
- Auth currently uses existing `AuthGuard` (API-key Bearer). Migration to Auth Arcana JWKS deferred to AUTH-0031 ecosystem-wide swap.
- Metrics counter (`mc_speech_proxy_total{endpoint,status_class}`) deferred — `MetricsService` is connector:model-keyed; speech proxy needs separate Prometheus surface, follow-up backlog item.

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
