# Together TTS Connector

Native text-to-speech connector for two exact upstream model identities:
`canopylabs/orpheus-3b-0.1-ft` and `cartesia/sonic-2`. Both use Together's
documented speech endpoint through one shared transport. The connector is
disabled by default and makes no provider call until explicitly enabled and
provisioned with a Together API key.

## Overview

| Field                 | Value                                              |
| --------------------- | -------------------------------------------------- |
| **Catalog connector** | `together-tts`                                     |
| **Modality**          | `text_to_speech`                                   |
| **Endpoint**          | `POST /v1/speech/tts`                              |
| **Upstream endpoint** | `POST https://api.together.ai/v1/audio/speech`     |
| **Models**            | `canopylabs/orpheus-3b-0.1-ft`, `cartesia/sonic-2` |
| **Output**            | WAV, non-streaming                                 |
| **Default state**     | Disabled                                           |
| **Authentication**    | `Bearer $TOGETHER_API_KEY` (server-side only)      |

## Request Contract

The provider and model fields are closed literals. Orpheus voices are a closed
enum. Sonic 2 voices are provider UUIDs; display names are not accepted because
they are not unique identities. Unknown models, aliases, and invalid voices are
rejected before any upstream call.

Orpheus:

```json
{
  "provider": "together",
  "model": "canopylabs/orpheus-3b-0.1-ft",
  "text": "Hello from Arcanada.",
  "voice": "tara"
}
```

Supported voices in the captured upstream snapshot are `tara`, `leah`, `jess`,
`leo`, `dan`, `mia`, `zac`, and `zoe`.

Sonic 2:

```json
{
  "provider": "together",
  "model": "cartesia/sonic-2",
  "text": "Hello from Arcanada.",
  "voice": "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"
}
```

The Sonic 2 voice ID above was present in the retrieval-dated Together voice
enumeration captured for CONN-0312. The full dynamic enumeration is research
evidence only: it is neither embedded nor fetched by the production request
path. A structurally valid UUID can still become stale and may be rejected by
Together through the connector's safe provider-error surface.

The service applies its existing 5,000-character request guard. That is a Model
Connector safety limit, not a claim about Together's model-specific maximum,
which was not published in the reviewed primary sources.

## Configuration

```bash
TTS_PROVIDER_TOGETHER_ENABLED=false
TOGETHER_API_KEY=
TOGETHER_BASE_URL=https://api.together.ai/v1
TTS_TOGETHER_TIMEOUT_MS=60000
```

Enabling the connector without a non-empty API key fails configuration
validation. Keep the API key in the server secret store; never place it in
browser configuration, HTML, logs, or version control.

## Catalog and Metadata Semantics

The catalog contains exactly one executable `together-tts` row per exact model.
Each row's `available` field follows `TTS_PROVIDER_TOGETHER_ENABLED`; both are
`false` by default. The public catalog's token-oriented `pricing`,
`priceMultiplier`, and `rateLimits` fields remain `null`, because character
prices must not be misrepresented as token prices.

Retrieval-dated native provenance records Together's published prices captured
on 2026-07-26: USD 15 per 1,000,000 input characters for Orpheus and USD 65 per
1,000,000 input characters for Sonic 2. No Sonic 2 Together-route language
matrix, model free tier, rate limit, or upstream maximum-input value was
confirmed, so those fields remain explicitly unknown.

The same canonical model ID appeared in the reviewed Hugging Face repository
metadata. That occurrence is provenance only: this connector does not create a
Hugging Face inference route.

## Safety and Error Handling

- Provider response bodies are discarded, not read, logged, or returned, on
  upstream errors.
- Authentication failures, rate limits, timeouts, and other unavailable states
  map to the existing safe speech error envelope.
- Orpheus accepts only its reviewed voice enum; Sonic 2 requires a UUID and
  performs no display-name or voice-cloning lookup.
- The connector does not log request text or credentials.

Do not use synthesized speech to impersonate a person, deceive listeners, or
cause harm. Those constraints follow the upstream project's stated responsible
use guidance.

## Primary Sources

- [Canopy Labs model card](https://huggingface.co/canopylabs/orpheus-3b-0.1-ft)
- [Canopy Labs Orpheus repository](https://github.com/canopyai/Orpheus-TTS)
- [Together text-to-speech overview](https://docs.together.ai/docs/inference/text-to-speech/overview)
- [Together audio speech API](https://docs.together.ai/reference/audio-speech)
- [Together serverless model pricing](https://docs.together.ai/docs/serverless/models)
- [Together Sonic 2 model page](https://www.together.ai/models/cartesia-sonic)

## Source

- Connector: `src/speech/tts/together-tts.connector.ts`
- Model definitions: `src/speech/tts/together-tts.model-definitions.ts`
- Provenance metadata: `src/speech/tts/together-orpheus.metadata.ts`,
  `src/speech/tts/together-cartesia-sonic-2.metadata.ts`
- Request schema: `src/speech/dto/tts-request.dto.ts`
- Tests: `src/speech/tts/together-tts.connector.spec.ts` and adjacent metadata
  suites
