# Deepgram Aura-1 text to speech

Model Connector provides default-off native REST coverage for the exact
Deepgram Aura-1 voices `aura-asteria-en`, `aura-luna-en`, and
`aura-stella-en`. It extends the existing `POST /v1/speech/tts` endpoint;
legacy requests continue to use Transcribator without a contract change.

## Request

```bash
curl -X POST https://connector.arcanada.ai/v1/speech/tts \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "deepgram",
    "model": "aura-stella-en",
    "text": "Hello from Model Connector."
  }' \
  --output speech.wav
```

The request is strict:

| Field      | Required | Contract                                                |
| ---------- | -------- | ------------------------------------------------------- |
| `provider` | yes      | Exactly `deepgram`.                                     |
| `model`    | yes      | `aura-asteria-en`, `aura-luna-en`, or `aura-stella-en`. |
| `text`     | yes      | 1–2,000 characters.                                     |

Unknown fields and other provider/model values are rejected. Requests without a
`provider` retain the existing legacy TTS fields and defaults.

## Response

A successful request returns the provider's binary audio response. Model
Connector always requests `linear16` in a WAV container at 24 kHz, rather than
depending on implicit provider defaults.

Only `Content-Type`, `Content-Length`, `Retry-After`, and `X-Request-ID` may be
forwarded from the provider response.

## Configuration

```dotenv
TTS_PROVIDER_DEEPGRAM_ENABLED=false
TTS_DEEPGRAM_API_KEY=
TTS_DEEPGRAM_BASE_URL=https://api.deepgram.com
TTS_DEEPGRAM_TIMEOUT_MS=30000
```

- The connector is disabled by default.
- Enabling it without `TTS_DEEPGRAM_API_KEY` fails startup.
- The key is a server-side secret used only in Deepgram's `Token`
  authorization header.
- The base URL accepts only the exact official HTTPS API origin, preventing an
  accidental credential-bearing request to another host.
- Timeout values must be between 1,000 and 120,000 milliseconds.

Provisioning or rotating the key, enabling the flag in a deployed environment,
and deploying the branch are operator-gated actions.

## Catalog metadata

The catalog lists one `deepgram-tts` row for each supported exact model under
`text_to_speech`. All `available` values follow the shared provider enable
flag. The similarly named `aura-2-luna-en` is a distinct model and is not an
alias or part of this contract. Current official documentation does not
enumerate `aura-2-stella-en`; no Stella alias is accepted without affirmative
upstream identity evidence.

The current catalog contract cannot faithfully express per-character prices or
project-scoped concurrency, so its public `pricing` and `rateLimits` fields
remain `null`. A contract-tested internal metadata record preserves the current
official values:

- Aura-1 PAYG: USD 0.015 per 1,000 characters.
- Aura-1 Growth: USD 0.0135 per 1,000 characters.
- Public PAYG project ceilings: 15 concurrent REST requests and 45 streaming
  connections.
- Account trial credit is not represented as a model free tier.

These values were retrieved from Deepgram's official documentation on
2026-07-26 and must be refreshed when the provider changes them.

## Errors

| HTTP | `error_code`                     | Meaning                                                    |
| ---- | -------------------------------- | ---------------------------------------------------------- |
| 400  | validation response              | Invalid strict request or text length.                     |
| 429  | `upstream_rate_limited`          | Deepgram returned 429.                                     |
| 502  | `upstream_authentication_failed` | Deepgram returned 401 or 403.                              |
| 502  | `upstream_unavailable`           | Network, provider, empty-audio, or invalid-media response. |
| 503  | `provider_disabled`              | The default-off connector is not enabled.                  |
| 504  | `upstream_timeout`               | The provider request exceeded the timeout.                 |

Provider error bodies and credential values are never returned. The connector
does not retry synthesis automatically and does not implement WebSocket
streaming.

## Primary sources

- [Deepgram TTS models](https://developers.deepgram.com/docs/tts-models)
- [Deepgram text-to-speech API](https://developers.deepgram.com/docs/text-to-speech)
- [Deepgram API rate limits](https://developers.deepgram.com/reference/api-rate-limits)
- [Deepgram pricing](https://deepgram.com/pricing)
