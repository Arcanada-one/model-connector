# Use the ElevenLabs native audio connector

`ElevenLabsConnector` is an internal NestJS provider exported by `SpeechModule`.
It adds no controller or public route.

Set `ELEVENLABS_API_KEY` in the service environment. The connector sends it only
in the `xi-api-key` request header. Keep real values in the deployment secret
store and out of source and logs.

```ts
const audio = await elevenLabs.textToSpeech({
  voiceId,
  text: 'Hello',
  modelId: 'eleven_multilingual_v2',
  outputFormat: 'mp3_44100_128',
});
```

The client covers chunked and non-streaming TTS and voice changing, uploaded-file
STT (default `scribe_v2`), dubbing create/status/list/audio/transcript/delete,
workspace voice search, individual voice reads, and shared-voice discovery.
Streaming calls expose the provider `ReadableStream` without buffering the complete
response first; non-streaming calls return complete response bytes.

Provider failures throw `ElevenLabsError`, preserving HTTP status, structured
detail, request/trace identifiers, and retry metadata when supplied. The client
does not log provider bodies or credentials.

The focused spec uses mocked `fetch` responses only; it performs no provider call
and requires no live credential.
