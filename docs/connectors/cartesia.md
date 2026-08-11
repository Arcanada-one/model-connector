# Cartesia native voice/TTS

The Cartesia child implements AU-006 for `Cartesia-Version: 2026-03-01`:

- `POST /tts/bytes` request construction and audio-byte responses;
- `WSS /tts/websocket` generation, continuation, flush, cancellation, chunk, timestamp, done, and error frames;
- `GET /voices` cursor pagination and `GET /voices/{id}` discovery;
- a version-pinned static catalog for `sonic-3.5`, `sonic-3`, and `sonic-latest`.

Consumers construct `CartesiaClient` with an API key and injected `CartesiaHttpPort` and `CartesiaWebSocketPort` adapters. Trusted server calls use `Authorization: Bearer <api_key>`. The client pins the required version header for HTTP and `cartesia_version` query parameter for WebSocket. It never logs credentials, transcripts, or audio.

The WebSocket protocol uses JSON text frames. Cartesia's `chunk.data` field is base64 audio; the client validates and decodes it to a `Buffer`. This must not be described as a provider binary WebSocket frame. Terminal `done` and `error` frames remain distinct, and provider error metadata is preserved in `CartesiaProviderError`.

Voice list pagination derives the next forward cursor from the last returned voice ID. The legacy `next_page` response is not used. Model discovery is static because the current first-party API reference documents accepted TTS model IDs but no public `GET /models` endpoint.

This child intentionally excludes SSE, STT, voice changer, voice creation/cloning/update/deletion, pronunciation-dictionary management, agents, fine-tunes, regional routing, and all other providers.

First-party references:

- [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions)
- [TTS bytes](https://docs.cartesia.ai/api-reference/tts/bytes)
- [TTS WebSocket](https://docs.cartesia.ai/api-reference/tts/websocket)
- [List voices](https://docs.cartesia.ai/api-reference/voices/list)
- [Get voice](https://docs.cartesia.ai/api-reference/voices/get)
