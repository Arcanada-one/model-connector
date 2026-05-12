# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-13

### Added

- **First-party client SDKs** (CONN-0093):
  - TypeScript — [`@arcanada/model-connector-sdk`](https://www.npmjs.com/package/@arcanada/model-connector-sdk) under `packages/sdk-ts/`. Dual ESM + CJS via `tsup`. Node >= 20. Zero runtime dependencies (uses global `fetch`).
  - Python — [`arcanada-model-connector`](https://pypi.org/project/arcanada-model-connector/) under `packages/sdk-python/`. Sync `Client` + `AsyncClient` via `httpx`. Pydantic v2 models. Python >= 3.10.
  - Both SDKs expose the full `/execute` schema including `output_format`, `schema`, and the `repair_report` envelope introduced in CONN-0089.
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

- **Output-guard middleware** on `POST /execute` (CONN-0089, M4 of CONN-0087, commit `3c89291`):
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
