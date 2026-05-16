# How to demo the STT multi-provider cascade

End-to-end walkthrough across the three STT phases. Pre-condition: caller has a
Model Connector API key (`MC_API_KEY=arc_api_…`) and a small audio fixture.

```bash
export MC=https://connector.arcanada.one
export MC_API_KEY=arc_api_…
export FIXTURE=./meeting.mp3   # any supported MIME, ≤25 MiB
```

## Phase 1a — single provider (Groq sync)

```bash
curl -sS -X POST "$MC/v1/speech/stt" \
  -H "Authorization: Bearer $MC_API_KEY" \
  -F "file=@$FIXTURE" \
  -F "language=en" | jq .
```

Expected: `200 OK`, `provider: "groq"`, `fallback_count: 0`. Detailed contract:
`docs/how-to/use-stt-endpoint.md`.

## Phase 1b — cascade (Groq → Deepgram → AssemblyAI → OpenAI)

Same endpoint. Toggle the cascade and watch the provider field plus the
`fallback_count` header:

```bash
# Operator-only: server env STT_MULTI_PROVIDER=true,
# STT_PROVIDERS_ORDER=groq,deepgram,assemblyai,openai
curl -sS -D - -X POST "$MC/v1/speech/stt" \
  -H "Authorization: Bearer $MC_API_KEY" \
  -F "file=@$FIXTURE" | tee /tmp/stt.json
```

When the primary provider returns `5xx`, the response still arrives as
`200 OK` but with `provider` set to the first surviving cascade hop and
`fallback_count ≥ 1`. The full provider list attempted is exposed in the
`providers_tried` envelope field.

## Phase 2 — faster-whisper async (self-hosted on arcana-ai)

Phase 2 ships POST `/v1/speech/stt/async` plus GET `/v1/speech/stt/jobs/:id`.
Use this path for long audio (> 60 s) or when you want zero per-second cost.

Pre-conditions:

- `STT_PROVIDER_LOCAL_WHISPER_ENABLED=true` on the connector.
- `LOCAL_WHISPER_BASE_URL=http://arcana-ai:8400` reachable from the connector
  worker (Tailscale).
- Whisper stack live on arcana-ai (`deploy/stt-whisper/docker-compose.yml`,
  health probe `curl -fsS http://arcana-ai:8400/health` returns `ok`).

### 1. Submit a job

```bash
RESP=$(curl -sS -X POST "$MC/v1/speech/stt/async" \
  -H "Authorization: Bearer $MC_API_KEY" \
  -F "file=@$FIXTURE" \
  -F "language=en")
echo "$RESP" | jq .
JOB_ID=$(echo "$RESP" | jq -r .job_id)
STATUS_URL=$(echo "$RESP" | jq -r .status_url)
echo "job_id=$JOB_ID"
```

Expected response (HTTP `202 Accepted`):

```json
{
  "job_id": "0194f2a0-1234-7000-8000-000000000001",
  "status": "queued",
  "status_url": "https://connector.arcanada.one/v1/speech/stt/jobs/0194f2a0-1234-7000-8000-000000000001"
}
```

`job_id` is a UUID v7 — time-sortable, unguessable (BOLA mitigation).

### 2. Poll the job

```bash
for i in $(seq 1 12); do
  BODY=$(curl -sS -H "Authorization: Bearer $MC_API_KEY" "$STATUS_URL")
  STATUS=$(echo "$BODY" | jq -r .status)
  echo "[$i] $STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "$BODY" | jq .
    break
  fi
  sleep 5
done
```

States: `queued → processing → completed | failed`. With the Phase 0 fixture
(13.7 s EN audio, RTF ≈ 1.05× on 4vCPU) the job typically completes in
`≤ 20 s` from submission.

Completed payload:

```json
{
  "job_id": "0194f2a0-1234-7000-8000-000000000001",
  "status": "completed",
  "result": {
    "transcription": "We are capturing live fixtures against the…",
    "language": "en",
    "duration_seconds": 13.7,
    "cost_usd": 0.0,
    "provider": "local-whisper"
  }
}
```

`cost_usd` is always `0.0` for the self-hosted path. The aggregate request
counter (`conn:stt:quota:req:YYYYMMDD`) still ticks, so the $10/day cap can
still trip on request volume alone (see § Quota behaviour).

### 3. Failure surface

```json
{
  "job_id": "0194f2a0-…",
  "status": "failed",
  "error": {
    "code": "transcription_failed",
    "message": "Whisper server returned 503"
  }
}
```

BullMQ retries twice (`attempts=2`); persistent failure surfaces the final
error code. GET on an unknown or foreign `job_id` returns `404` with an empty
body — no information leak across API keys.

### Quota behaviour

| Trigger | Surface |
|---------|---------|
| `STT_DAILY_BUDGET_USD` aggregate cost ≥ cap | POST returns `503 stt_budget_exhausted` before queuing |
| Per-day request counter present | `redis-cli GET conn:stt:quota:req:YYYYMMDD` (counter), `TTL` ≤ 86400 (UTC midnight) |
| Counter survives restart | Redis-persistent (CONN-0104 fixes M2) |

### Network topology recap

- Worker → Whisper: `http://arcana-ai:8400/v1/audio/transcriptions` (Tailscale only)
- Worker → Redis: `arcana-db:6379` (existing)
- Client → Connector: `https://connector.arcanada.one` (public, bcrypt API key)

## Smoke script

`scripts/smoke-stt-async.sh` runs steps 1–2 end-to-end against PROD with a
checked-in fixture. Use it from the operator workstation after a deploy:

```bash
MC_KEY=$MC_API_KEY ./scripts/smoke-stt-async.sh
```

Expected exit `0` when the job reaches `completed` within `60 s` and the
transcription contains the fixture's marker phrase.
