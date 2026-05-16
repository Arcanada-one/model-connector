# How to call `POST /v1/speech/stt`

Phase 1a ships Groq Whisper (`whisper-large-v3`) as the single STT provider.
This guide covers the synchronous endpoint — async batch transcription (long
audio, self-hosted Whisper) is scoped to a later phase.

## Request

```bash
curl -X POST https://connector.arcanada.one/v1/speech/stt \
  -H "Authorization: Bearer $MC_API_KEY" \
  -F "file=@./meeting.mp3" \
  -F "model=whisper-large-v3" \
  -F "language=en"
```

### Form fields

| Field | Required | Notes |
|-------|----------|-------|
| `file` | yes | Audio payload. Max 25 MiB; oversize rejected before upstream. |
| `model` | no | Defaults to server-side `STT_GROQ_MODEL` (`whisper-large-v3`). Override per call e.g. `whisper-large-v3-turbo`. |
| `language` | no | BCP-47 hint (`en`, `en-US`). Whisper auto-detects when omitted. |
| `prompt` | no | Bias prompt, ≤1024 chars (acronyms, names, domain terms). |
| `temperature` | no | 0.0..1.0 sampling temperature. |

Accepted MIME types: `audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/mp3`,
`audio/mp4`, `audio/x-m4a`, `audio/webm`, `audio/ogg`, `audio/flac`,
`audio/x-flac`. MIME suffixes such as `audio/mp4;codecs=mp4a.40.2` are
normalised server-side.

## Response

`200 OK` with envelope:

```json
{
  "transcription": "We are capturing live fixtures against the Groq Whisper model.",
  "model": "whisper-large-v3",
  "provider": "groq",
  "language": "en",
  "latency_ms": 1331,
  "cost_usd": 0.000423,
  "audio_duration_seconds": 13.7,
  "fallback_count": 0,
  "request_id": "<uuid>"
}
```

`fallback_count` is always `0` in Phase 1a (single provider). Phase 1b will
increment per cascade hop.

## Errors

| HTTP | `error_code` | Cause |
|------|---------------|-------|
| 400 | `stt_validation_error` | Missing file field, malformed form values, unknown extra fields. |
| 400 | `stt_unsupported_mime` | MIME outside the whitelist. |
| 413 | `stt_audio_too_large` | Payload exceeds `STT_MAX_AUDIO_BYTES` (default 25 MiB). |
| 401 | `unauthorized` | Missing or invalid API key. |
| 429 | `stt_provider_failed` | Upstream rate-limit (Groq 429). |
| 502 | `stt_provider_failed` | Upstream auth / payload / network failure. |
| 503 | `stt_all_providers_exhausted` | No enabled provider remaining (e.g. all toggled off). |
| 504 | `stt_provider_failed` | Upstream timeout (per `STT_GROQ_TIMEOUT_MS`). |

All non-success responses carry `X-Request-ID` matching the request header
(or an auto-issued UUID).

## Observability

- Every call appends one row to `SttTranscription` (success and failure
  paths). Audit fields: `provider`, `model`, `language`, `audioBytes`,
  `audioDurationSeconds`, `mimeType`, `transcriptionPreview` (first 80
  chars), `costUsd`, `latencyMs`, `status`, `errorType`, `requestId`.
- `MetricsService.getAllStt()` exposes per `provider:model` counters
  (`successCount`, `errorCount`, `errorTypeCounts`, `totalCostUsd`,
  `avgLatencyMs`, `totalAudioDurationSeconds`).
- Daily Groq spend warning: when aggregate cost crosses 80 % of
  `STT_DAILY_BUDGET_USD` (default $10) within a UTC day, `pino.warn` fires
  once. **No hard 503 in Phase 1a** — that gate lands in Phase 1b together
  with the multi-provider cascade.

## Configuration cheat-sheet

| Variable | Default | Purpose |
|----------|---------|---------|
| `STT_GROQ_API_KEY` | _unset_ | Falls back to `GROQ_API_KEY` (chat surface) when missing. |
| `STT_GROQ_MODEL` | `whisper-large-v3` | Server-side default model. |
| `STT_GROQ_PRICE_USD_PER_MIN` | `0.00185` | Cost telemetry baseline (provider pricing). |
| `STT_GROQ_TIMEOUT_MS` | `60000` | Per-request fetch timeout. |
| `STT_GROQ_MAX_CONCURRENCY` | `10` | Semaphore cap for outbound Groq calls. |
| `STT_PROVIDERS_ORDER` | `groq` | Comma-separated priority list (Phase 1b extends). |
| `STT_PROVIDER_GROQ_ENABLED` | `true` | Per-provider kill-switch. |
| `STT_MULTI_PROVIDER` | `false` | Phase 1a stays single-provider. |
| `STT_MAX_AUDIO_BYTES` | `26214400` | Hard cap, enforced both at multipart layer and router. |
| `STT_DAILY_BUDGET_USD` | `10` | Used by soft-warn aggregator. |
| `STT_COST_WARN_THRESHOLD_PCT` | `0.8` | Fraction of daily budget that triggers warning. |

## Smoke test

The endpoint is exercised end-to-end via MSW in
`src/speech/stt/stt-pilot.integration.spec.ts` (run with
`pnpm test:integration`). Provider response shapes are derived from a live
Groq capture maintained out-of-tree.
