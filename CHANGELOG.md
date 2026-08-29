# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The ledger now survives real money (ARAS-0058)** — six findings on the billing path,
  every one of which was invisible while `costUsd` was still zero and every one of which
  becomes a way to lose money the moment it is not.

  - **Settlement was fire-and-forget.** `logRequest(...).catch(...)` was not awaited, and
    `settleSpend` lived inside it. The response reached the customer before the `Request`
    row or the ledger row existed, so a SIGTERM, a deploy or an OOM in that window meant
    the provider had been paid and the customer had not. Billing was bolted onto a
    telemetry path and the durability requirement was never re-derived. The call is now
    awaited, and the `Request` row and its charge commit in **one transaction** — so the
    two cannot diverge, rather than being repaired after they do.
  - **The compensating control now exists.** `settleSpend`'s docstring justified being
    non-fatal on the grounds that the ledger was recoverable from the `Request` row. That
    recovery job was never written. `BillingReconcilerService` is it: an anti-join for
    `Request` rows carrying spend with no matching `credits_ledger.request_id`, exposed at
    `POST /admin/credits/reconcile` (**dry run by default**) and bounded to the recent past
    so it can never backfill history it was not asked to. Automatic charging ships **off**
    (`BILLING_RECONCILE_ENABLED`).
  - **The precheck did not hold anything.** `precheck()` was a plain `findUnique` and
    `post()` an unguarded `increment` with a negative value: N parallel requests on one
    balance all read it, all passed, all dispatched, all debited — and `arcana` IS a
    parallel agent, so that was the normal traffic shape. Replaced with a real reservation
    (`credits_balance.held_usd` + `request_intent`) taken by a conditional `UPDATE`
    carrying `WHERE balance_usd - held_usd >= amount`. Proved with twelve concurrent
    requests against a one-request balance: exactly one is admitted.
  - **A floor the database enforces.** `CHECK (balance_usd >= 0)` on `credits_balance`,
    which is the only thing that cannot be raced. Because the provider is already paid by
    the time settlement runs, a charge is never allowed to fail against it: the charge is
    recorded in full and the part a depleted balance cannot cover is posted back as an
    explicit `uncollectible` ledger entry, so `balance = SUM(ledger)` and `balance >= 0`
    hold at once and lost revenue is a queryable SUM.
  - **Idempotency is per intent, not per attempt.** The ledger key was
    `request:${created.id}`, a uuid minted inside the logging path — unique per ATTEMPT, so
    it could only deduplicate a retry of `settle()`, which nothing performs. A client
    timeout plus a re-POST was a second provider call and a second charge. `POST /execute`
    and `POST /connectors/:name/execute` now accept an `Idempotency-Key` header: one
    provider call and one ledger row across a replay.
  - **The estimate was beatable by a caller-controlled parameter.** `estimateCostUsd`
    hardcoded 2 000 output tokens and ignored `max_tokens` entirely — roughly a 32x
    under-estimate on an expensive model, chosen by the caller. `max_tokens` is now folded
    in (upward only; a small value is a request, not a guarantee), multi-modal prompts are
    measured in characters rather than blocks, and `BILLING_MAX_REQUEST_COST_USD` caps
    what one request may cost.
  - **`BILLING_ENFORCED` was declared nowhere outside `src/`** — not in `.env.example`,
    not in `docker-compose.yml`, not in `deploy/`, not in CI. It was set by hand on the
    prod container, so the next deploy that rebuilt the env from the template would have
    silently disabled billing, and the failure mode is *successful free service*. Now
    declared in `.env.example`, asserted in CI by `dev-tools/env-declaration-parity.sh`,
    and asserted against the running container by the deploy job.

  `billingEnforced()` still fails OPEN, deliberately: with gift credits a config error must
  not deny every caller. The seam for the live-money inversion (`BILLING_LIVE_MODE`) is in
  place and inert — flipping it is a separate, operator-approved change.

### Added

- **OpenAI-compatible failover gateway (CONN-0243)** — Model Connector now speaks the
  OpenAI wire protocol and fails over across providers, so any OpenAI-shaped client
  (Hermes custom provider, coworker, OpenAI SDK / LiteLLM) can point `base_url` at MC
  and survive a single provider's rate-limit / over-quota without its own fallback. This
  is the durable form of the Hermes 2026-06-24 rate-limit fix.
  - **`POST /v1/chat/completions`** — OpenAI-shaped chat completions with transparent
    **free-first cross-provider failover** (DeepSeek first) on `429` / `5xx` / connection
    error / open circuit. The chosen candidate is retried once (no compounded backoff);
    on failure the next free candidate serves. Exact OpenAI response shape
    (`chatcmpl-<uuid>`, `usage.{prompt_tokens,completion_tokens,total_tokens}`,
    `finish_reason:"stop"`). `stream:true` and `tools`/`tool_choice` return `400` (planned
    follow-ups); all candidates exhausted returns `503` `cascade_exhausted`.
  - **`GET /v1/models`** — OpenAI model-list shape, chat models only, built from in-memory
    connector capabilities (no per-request network probes).
  - **Free-first ordering** is driven by the existing CONN-0233 free-tier metadata +
    CONN-0232 catalog modality, reusing the CONN-0223 cascade candidate type and error
    classification. ANTI-FABRICATION: candidates come only from models the connectors
    declare; live availability is enforced by the failover loop.
  - New env: `FAILOVER_PROVIDER_ORDER`, `FAILOVER_DEEPSEEK_MODEL`, `FAILOVER_PAID_ENABLED`,
    `FAILOVER_ALLOW_FREE_DOWNGRADE`. New `ConnectorRequest.maxRetries` lets the gateway
    bypass the inner per-connector retry loop. Diátaxis docs:
    `docs/how-to/openai-compatible-failover.md`, `docs/reference/v1-openai-surface.md`.

### Fixed

- **Read-only showcase keys can no longer silently collapse the public catalog (CONN-1674)** —
  a per-key policy change on the `arcanada-landing-catalog` key (which backs the public
  ecosystem catalog page) narrowed the public surface from 998 models / 26 providers to
  33 / 3, and nothing alarmed — it was caught by eye. A showcase key backs a read-only
  public surface and must see the full catalog; any narrowing of its policy is a defect.
  Two guards now enforce this, driven by a new `SHOWCASE_KEY_IDS` env (CSV of key ids):
  - **Write-time guard** — `PATCH /admin/keys/:id/policy` rejects (400) any policy that
    restricts `providers` or sets `models.mode` to non-`all` on a listed showcase key.
  - **Runtime alarm** — `getCatalog` warns when a showcase key's response is trimmed past
    `SHOWCASE_CATALOG_NARROW_ALARM_PCT` (default 0.5) of the visible catalog, catching a
    narrowing applied out of band (e.g. a direct DB edit) that the write-time guard cannot
    see. The served response is unchanged (observational). Consumer-key registry + rule
    documented in `docs/how-to/onboard-agent-to-mc.md` § Read-only showcase keys.
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
