# Azure Speech connector

The Azure Speech child exposes five provider-native operation families:

- synchronous fast transcription;
- batch transcription submit, status, files, delete, and bounded polling;
- real-time transcription through an injected streaming transport;
- SSML text-to-speech synthesis;
- runtime voice discovery.

It is an additive NestJS module under `src/connectors/azure-speech/`. The
connector does not make a network request until one of its operation methods is
called. Callers supply both HTTP and streaming transports, which keeps the
provider contract testable without credentials or paid Azure calls.

## Deployment and authentication

`AzureSpeechDeployment` keeps public regional and explicit resource endpoints
separate.

- A public region uses `{region}.api.cognitive.microsoft.com` for fast and
  batch transcription, `{region}.stt.speech.microsoft.com` for streaming, and
  `{region}.tts.speech.microsoft.com` for synthesis and voices.
- A resource endpoint is a complete HTTPS authority, such as the custom domain
  shown on an Azure Speech resource. The connector does not derive a public
  cloud suffix, so private and sovereign deployments remain explicit.

`AzureSpeechAuthentication` is a discriminated union:

- `resource-key` sends `Ocp-Apim-Subscription-Key`;
- `microsoft-entra` sends the documented
  `Authorization: Bearer aad#<resource-id>#<access-token>` form for synthesis
  and voice discovery.

The generally available Speech to Text REST API `2025-10-15` operation
references declare resource-key authentication for fast and batch
transcription. Those methods reject Microsoft Entra authentication before
transport. Network-restricted custom endpoints also require the resource-key
form. Streaming passes the discriminated authentication object to the injected
adapter; this package makes no claim about raw WebSocket handshake headers.

## Operation boundaries

### Fast transcription

`fastTranscribe()` posts multipart `audio` and JSON `definition` fields to
`/speechtotext/transcriptions:transcribe?api-version=2025-10-15`. It applies
the stricter operation-reference limits: audio must be smaller than 250 MB and
shorter than two hours. Microsoft also publishes broader quota-page values, so
the capability metadata records that documentation drift.

### Batch transcription

`submitBatchTranscription()` accepts exactly one of `contentUrls` or
`contentContainerUrl`. Individual URL submissions are limited to 1,000
entries. When supplied, `timeToLiveHours` must be an integer from 6 through 744.

The remaining lifecycle methods are:

- `getBatchTranscription()` for documented status;
- `listBatchTranscriptionFiles()` after `Succeeded`;
- `deleteBatchTranscription()` for the destructive deletion boundary;
- `pollBatchTranscription()` with caller-owned attempt limits, abort support,
  and a minimum 60-second interval.

The documented states are `NotStarted`, `Running`, `Succeeded`, and `Failed`.
Azure documents no separate reversible cancel or pause operation. Remote blob
and container limits remain provider-enforced and are described in
`AZURE_SPEECH_CAPABILITIES`.

### Real-time streaming

`streamTranscription()` constructs the documented recognition URL, locale,
output format, optional custom endpoint ID, and audio metadata, then delegates
to `AzureSpeechStreamingTransport`. The accepted documented content types are
16 kHz mono WAV/PCM and OGG/Opus.

The connector deliberately does not create WebSockets or invent message
frames. The injected adapter owns transport I/O and converts provider events
into `AzureSpeechRecognitionEvent` values. Caller timeout and abort controls
cross that boundary unchanged.

### Synthesis and voices

`synthesizeSpeech()` posts SSML to `/cognitiveservices/v1` with
`application/ssml+xml`, `X-Microsoft-OutputFormat`, and `User-Agent` headers.
Azure's ten-minute output ceiling and 50 distinct `<voice>`/`<audio>` tag
limit are provider constraints; the connector does not pretend to infer output
duration or parse XML without a dependency.

`listVoices()` calls `/cognitiveservices/voices/list` and returns the runtime
provider list. No static voice, locale, model, or region catalogue is embedded.
Provider entries may report either generally available or preview status; the
operation itself is not treated as a preview-only catalogue.

## Error contract

Non-success HTTP responses throw `AzureSpeechError`. The error retains HTTP
status, provider code, message, details, inner error, and the original response
payload when present. Locally rejected input uses status `0` and an explicit
connector code.

## Offline verification

The connector specs use injected transports and documentation-derived
fixtures only:

```bash
pnpm exec vitest run src/connectors/azure-speech
```

The fixtures are not captured provider traffic and are not evidence of a live
Azure request. Their source references and verification date are recorded in
`src/connectors/azure-speech/__fixtures__/README.md`.
