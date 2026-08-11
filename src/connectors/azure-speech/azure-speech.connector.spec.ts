import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AZURE_SPEECH_CAPABILITIES,
  AzureSpeechConnector,
  AzureSpeechError,
  validateFastTranscriptionLimits,
  type AzureSpeechConnectorOptions,
  type AzureSpeechHttpTransport,
  type AzureSpeechRecognitionEvent,
  type AzureSpeechStreamingTransport,
} from './index';

const transcriptionId = '11111111-1111-1111-1111-111111111111';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as T;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function audioChunks(): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array([1, 2, 3]);
    },
  };
}

async function collectEvents(
  iterable: AsyncIterable<AzureSpeechRecognitionEvent>,
): Promise<AzureSpeechRecognitionEvent[]> {
  const events: AzureSpeechRecognitionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('AzureSpeechConnector', () => {
  let httpTransport: ReturnType<typeof vi.fn<AzureSpeechHttpTransport>>;
  let streamingTransport: AzureSpeechStreamingTransport;
  let connect: ReturnType<typeof vi.fn<AzureSpeechStreamingTransport['connect']>>;
  let delay: ReturnType<typeof vi.fn<(milliseconds: number) => Promise<void>>>;

  const baseOptions = (): AzureSpeechConnectorOptions => ({
    deployment: { kind: 'public-region', region: 'eastus' },
    authentication: { kind: 'resource-key', key: 'offline-resource-key' },
    httpTransport,
    streamingTransport,
    delay,
  });

  beforeEach(() => {
    httpTransport = vi.fn<AzureSpeechHttpTransport>();
    connect = vi.fn<AzureSpeechStreamingTransport['connect']>();
    streamingTransport = { connect };
    delay = vi.fn(async () => undefined);
  });

  describe('authentication, deployment, and geography', () => {
    it('uses the public regional management host and key for fast transcription', async () => {
      httpTransport.mockResolvedValueOnce(jsonResponse(fixture('fast-success.json')));
      const connector = new AzureSpeechConnector(baseOptions());

      await connector.fastTranscribe({
        audio: new Uint8Array([82, 73, 70, 70]),
        filename: 'fixture.wav',
        mimeType: 'audio/wav',
        definition: { locales: ['en-US'] },
      });

      const [url, init] = httpTransport.mock.calls[0];
      expect(url).toBe(
        'https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
      );
      expect(init.headers).toMatchObject({
        'Ocp-Apim-Subscription-Key': 'offline-resource-key',
      });
      expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('uses the resource authority without an /stt prefix for fast transcription', async () => {
      httpTransport.mockResolvedValueOnce(jsonResponse(fixture('fast-success.json')));
      const connector = new AzureSpeechConnector({
        ...baseOptions(),
        deployment: {
          kind: 'resource-endpoint',
          endpoint: 'https://speech-private.example.invalid',
          networkAccess: 'restricted',
        },
      });

      await connector.fastTranscribe({
        audio: new Uint8Array([1]),
        filename: 'fixture.wav',
        mimeType: 'audio/wav',
        definition: { locales: ['en-US'] },
      });

      expect(httpTransport.mock.calls[0][0]).toBe(
        'https://speech-private.example.invalid/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
      );
    });

    it('rejects Microsoft Entra for current fast and batch REST before transport', async () => {
      const connector = new AzureSpeechConnector({
        ...baseOptions(),
        authentication: {
          kind: 'microsoft-entra',
          resourceId: '/subscriptions/offline/resource',
          accessToken: 'offline-access-token',
        },
      });

      await expect(
        connector.fastTranscribe({
          audio: new Uint8Array([1]),
          filename: 'fixture.wav',
          mimeType: 'audio/wav',
          definition: { locales: ['en-US'] },
        }),
      ).rejects.toMatchObject({ code: 'UnsupportedAuthentication' });
      await expect(
        connector.submitBatchTranscription({
          displayName: 'fixture',
          locale: 'en-US',
          contentUrls: ['https://example.invalid/audio.wav'],
          properties: { timeToLiveHours: 48 },
        }),
      ).rejects.toMatchObject({ code: 'UnsupportedAuthentication' });
      expect(httpTransport).not.toHaveBeenCalled();
    });

    it('formats Microsoft Entra exactly for public voice discovery', async () => {
      httpTransport.mockResolvedValueOnce(jsonResponse(fixture('voices.json')));
      const connector = new AzureSpeechConnector({
        ...baseOptions(),
        authentication: {
          kind: 'microsoft-entra',
          resourceId: '/subscriptions/offline/resource',
          accessToken: 'offline-access-token',
        },
      });

      await connector.listVoices();

      expect(httpTransport.mock.calls[0][1].headers).toMatchObject({
        Authorization: 'Bearer aad#/subscriptions/offline/resource#offline-access-token',
      });
      expect(httpTransport.mock.calls[0][1].headers).not.toHaveProperty(
        'Ocp-Apim-Subscription-Key',
      );
    });

    it('rejects Microsoft Entra for a restricted resource endpoint before transport', async () => {
      const connector = new AzureSpeechConnector({
        ...baseOptions(),
        deployment: {
          kind: 'resource-endpoint',
          endpoint: 'https://speech-private.example.invalid',
          networkAccess: 'restricted',
        },
        authentication: {
          kind: 'microsoft-entra',
          resourceId: '/subscriptions/offline/resource',
          accessToken: 'offline-access-token',
        },
      });

      await expect(connector.listVoices()).rejects.toMatchObject({
        code: 'UnsupportedAuthentication',
      });
      expect(httpTransport).not.toHaveBeenCalled();
    });

    it('allows Microsoft Entra for an all-networks resource endpoint', async () => {
      httpTransport.mockResolvedValueOnce(jsonResponse(fixture('voices.json')));
      const connector = new AzureSpeechConnector({
        ...baseOptions(),
        deployment: {
          kind: 'resource-endpoint',
          endpoint: 'https://speech-custom.example.invalid',
          networkAccess: 'all-networks',
        },
        authentication: {
          kind: 'microsoft-entra',
          resourceId: '/subscriptions/offline/resource',
          accessToken: 'offline-access-token',
        },
      });

      await connector.listVoices();

      expect(httpTransport.mock.calls[0][0]).toBe(
        'https://speech-custom.example.invalid/tts/cognitiveservices/voices/list',
      );
    });

    it('rejects a resource endpoint with path, query, fragment, or non-HTTPS scheme', () => {
      for (const endpoint of [
        'http://speech.example.invalid',
        'https://speech.example.invalid/path',
        'https://speech.example.invalid?query=1',
        'https://speech.example.invalid#fragment',
      ]) {
        expect(
          () =>
            new AzureSpeechConnector({
              ...baseOptions(),
              deployment: {
                kind: 'resource-endpoint',
                endpoint,
                networkAccess: 'all-networks',
              },
            }),
        ).toThrow(/HTTPS authority/);
      }
    });
  });

  describe('fast transcription', () => {
    it('sends binary audio and a serialized definition as multipart fields', async () => {
      const responseFixture = fixture<Record<string, unknown>>('fast-success.json');
      httpTransport.mockResolvedValueOnce(jsonResponse(responseFixture));
      const connector = new AzureSpeechConnector(baseOptions());

      const result = await connector.fastTranscribe({
        audio: new Uint8Array([82, 73, 70, 70]),
        filename: 'fixture.wav',
        mimeType: 'audio/wav',
        durationSeconds: 1.7,
        definition: { locales: ['en-US'], profanityFilterMode: 'Masked' },
      });

      expect(result).toEqual(responseFixture);
      const body = httpTransport.mock.calls[0][1].body as FormData;
      const audio = body.get('audio');
      expect(audio).toBeInstanceOf(Blob);
      expect((audio as Blob).size).toBe(4);
      expect((audio as Blob).type).toBe('audio/wav');
      expect(body.get('definition')).toBe(
        JSON.stringify({ locales: ['en-US'], profanityFilterMode: 'Masked' }),
      );
      expect(httpTransport.mock.calls[0][1].headers).not.toHaveProperty('Content-Type');
    });

    it('enforces the stricter operation-reference size and duration boundaries', () => {
      expect(() => validateFastTranscriptionLimits(249_999_999, 7_199.999)).not.toThrow();
      expect(() => validateFastTranscriptionLimits(250_000_000, 1)).toThrow(/250 MB/);
      expect(() => validateFastTranscriptionLimits(1, 7_200)).toThrow(/two hours/);
    });

    it('preserves the provider payload on an HTTP error', async () => {
      const errorFixture = fixture<Record<string, unknown>>('provider-error.json');
      httpTransport.mockResolvedValueOnce(jsonResponse(errorFixture, 400));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(
        connector.fastTranscribe({
          audio: new Uint8Array([1]),
          filename: 'fixture.wav',
          mimeType: 'audio/wav',
          definition: { locales: ['en-US'] },
        }),
      ).rejects.toMatchObject({
        name: 'AzureSpeechError',
        statusCode: 400,
        code: 'InvalidRequest',
        message: 'The request was invalid.',
        payload: errorFixture,
      });
    });
  });

  describe('batch transcription lifecycle', () => {
    it('submits exactly one input source and preserves body plus Location', async () => {
      const created = fixture<Record<string, unknown>>('batch-not-started.json');
      httpTransport.mockResolvedValueOnce(
        jsonResponse(created, 201, {
          Location:
            'https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions/11111111-1111-1111-1111-111111111111?api-version=2025-10-15',
        }),
      );
      const connector = new AzureSpeechConnector(baseOptions());

      const result = await connector.submitBatchTranscription({
        displayName: 'Offline contract fixture',
        locale: 'en-US',
        contentUrls: ['https://example.invalid/audio.wav'],
        properties: { timeToLiveHours: 48 },
      });

      expect(result.transcription).toEqual(created);
      expect(result.location).toContain(transcriptionId);
      const [url, init] = httpTransport.mock.calls[0];
      expect(url).toBe(
        'https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions:submit?api-version=2025-10-15',
      );
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': 'offline-resource-key',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        displayName: 'Offline contract fixture',
        locale: 'en-US',
        contentUrls: ['https://example.invalid/audio.wav'],
        properties: { timeToLiveHours: 48 },
      });
    });

    it('rejects both/neither input source, excessive URLs, and invalid TTL before transport', async () => {
      const connector = new AzureSpeechConnector(baseOptions());
      const common = {
        displayName: 'fixture',
        locale: 'en-US',
        properties: { timeToLiveHours: 48 },
      };

      await expect(
        connector.submitBatchTranscription({
          ...common,
          contentUrls: ['https://example.invalid/audio.wav'],
          contentContainerUrl: 'https://example.invalid/container',
        }),
      ).rejects.toMatchObject({ code: 'InvalidBatchInput' });
      await expect(connector.submitBatchTranscription(common)).rejects.toMatchObject({
        code: 'InvalidBatchInput',
      });
      await expect(
        connector.submitBatchTranscription({
          ...common,
          contentUrls: Array.from(
            { length: 1_001 },
            (_, index) => `https://example.invalid/${index}.wav`,
          ),
        }),
      ).rejects.toMatchObject({ code: 'InvalidBatchInput' });
      await expect(
        connector.submitBatchTranscription({
          ...common,
          contentUrls: ['https://example.invalid/audio.wav'],
          properties: { timeToLiveHours: 5 },
        }),
      ).rejects.toMatchObject({ code: 'InvalidBatchInput' });
      await expect(
        connector.submitBatchTranscription({
          ...common,
          contentUrls: ['https://example.invalid/audio.wav'],
          properties: { timeToLiveHours: 745 },
        }),
      ).rejects.toMatchObject({ code: 'InvalidBatchInput' });
      expect(httpTransport).not.toHaveBeenCalled();
    });

    it('gets a versioned transcription status', async () => {
      const running = fixture<Record<string, unknown>>('batch-running.json');
      httpTransport.mockResolvedValueOnce(jsonResponse(running));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(connector.getBatchTranscription(transcriptionId)).resolves.toEqual(running);
      expect(httpTransport.mock.calls[0][0]).toBe(
        `https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions/${transcriptionId}?api-version=2025-10-15`,
      );
    });

    it('checks Succeeded before listing versioned result files', async () => {
      const succeeded = fixture<Record<string, unknown>>('batch-succeeded.json');
      const files = fixture<Record<string, unknown>>('batch-files.json');
      httpTransport
        .mockResolvedValueOnce(jsonResponse(succeeded))
        .mockResolvedValueOnce(jsonResponse(files));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(connector.listBatchTranscriptionFiles(transcriptionId)).resolves.toEqual(files);
      expect(httpTransport.mock.calls[1][0]).toBe(
        `https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions/${transcriptionId}/files?api-version=2025-10-15`,
      );
    });

    it('does not request files while a transcription is nonterminal', async () => {
      httpTransport.mockResolvedValueOnce(jsonResponse(fixture('batch-running.json')));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(connector.listBatchTranscriptionFiles(transcriptionId)).rejects.toMatchObject({
        code: 'BatchNotSucceeded',
      });
      expect(httpTransport).toHaveBeenCalledTimes(1);
    });

    it('deletes the transcription resource as the cancellation boundary', async () => {
      httpTransport.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(connector.deleteBatchTranscription(transcriptionId)).resolves.toBeUndefined();
      expect(httpTransport.mock.calls[0][0]).toBe(
        `https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions/${transcriptionId}?api-version=2025-10-15`,
      );
      expect(httpTransport.mock.calls[0][1].method).toBe('DELETE');
      expect(AZURE_SPEECH_CAPABILITIES.batch.cancellation).toBe(
        'delete-resource-no-separate-cancel',
      );
    });

    it('polls with injected delay until Succeeded', async () => {
      const running = fixture<Record<string, unknown>>('batch-running.json');
      const succeeded = fixture<Record<string, unknown>>('batch-succeeded.json');
      httpTransport
        .mockResolvedValueOnce(jsonResponse(running))
        .mockResolvedValueOnce(jsonResponse(succeeded));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(
        connector.pollBatchTranscription(transcriptionId, {
          maxAttempts: 3,
          intervalMs: 60_000,
        }),
      ).resolves.toEqual(succeeded);
      expect(delay).toHaveBeenCalledOnce();
      expect(delay).toHaveBeenCalledWith(60_000);
    });

    it('surfaces a Failed state with the unmodified transcription payload', async () => {
      const failed = fixture<Record<string, unknown>>('batch-failed.json');
      httpTransport.mockResolvedValueOnce(jsonResponse(failed));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(
        connector.pollBatchTranscription(transcriptionId, {
          maxAttempts: 2,
          intervalMs: 60_000,
        }),
      ).rejects.toMatchObject({
        code: 'InvalidAudioFormat',
        payload: failed,
      });
      expect(delay).not.toHaveBeenCalled();
    });

    it('times out after the caller maximum without an unbounded loop', async () => {
      httpTransport
        .mockResolvedValueOnce(jsonResponse(fixture('batch-not-started.json')))
        .mockResolvedValueOnce(jsonResponse(fixture('batch-running.json')));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(
        connector.pollBatchTranscription(transcriptionId, {
          maxAttempts: 2,
          intervalMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: 'PollingLimitExceeded' });
      expect(httpTransport).toHaveBeenCalledTimes(2);
      expect(delay).toHaveBeenCalledTimes(1);
    });

    it('stops before transport when already aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(
        connector.pollBatchTranscription(transcriptionId, {
          maxAttempts: 2,
          intervalMs: 60_000,
          signal: abortController.signal,
        }),
      ).rejects.toMatchObject({ code: 'Aborted' });
      expect(httpTransport).not.toHaveBeenCalled();
    });

    it('uses the documented polling floor by default and rejects faster polling', async () => {
      const running = fixture<Record<string, unknown>>('batch-running.json');
      const succeeded = fixture<Record<string, unknown>>('batch-succeeded.json');
      httpTransport
        .mockResolvedValueOnce(jsonResponse(running))
        .mockResolvedValueOnce(jsonResponse(succeeded));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(
        connector.pollBatchTranscription(transcriptionId, {
          maxAttempts: 2,
        }),
      ).resolves.toEqual(succeeded);
      expect(delay).toHaveBeenCalledWith(60_000);

      httpTransport.mockClear();
      await expect(
        connector.pollBatchTranscription(transcriptionId, {
          maxAttempts: 2,
          intervalMs: 59_999,
        }),
      ).rejects.toMatchObject({ code: 'InvalidPollingOptions' });
      expect(httpTransport).not.toHaveBeenCalled();
    });
  });

  describe('real-time streaming boundary', () => {
    it('hands documented public inputs to the injected transport and forwards events', async () => {
      const events: AzureSpeechRecognitionEvent[] = [
        { kind: 'recognizing', text: 'Hello' },
        { kind: 'recognized', text: 'Hello world' },
        {
          kind: 'error',
          code: 'ConnectionFailure',
          message: 'Offline streaming fixture error',
        },
      ];
      connect.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      }));
      const connector = new AzureSpeechConnector(baseOptions());
      const inputAudio = audioChunks();
      const abortController = new AbortController();

      const received: AzureSpeechRecognitionEvent[] = [];
      for await (const event of connector.streamTranscription({
        locale: 'en-US',
        outputFormat: 'detailed',
        contentType: 'audio/wav; codecs=audio/pcm; samplerate=16000',
        customEndpointId: '33333333-3333-3333-3333-333333333333',
        audio: inputAudio,
        timeoutMs: 30_000,
        signal: abortController.signal,
      })) {
        received.push(event);
      }

      expect(received).toEqual(events);
      expect(connect).toHaveBeenCalledOnce();
      expect(connect.mock.calls[0][0]).toMatchObject({
        url: 'wss://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed&cid=33333333-3333-3333-3333-333333333333',
        authentication: { kind: 'resource-key', key: 'offline-resource-key' },
        contentType: 'audio/wav; codecs=audio/pcm; samplerate=16000',
        audio: inputAudio,
        timeoutMs: 30_000,
        signal: abortController.signal,
      });
    });

    it('uses the /stt private/custom path and preserves opaque Entra auth on all-networks', async () => {
      connect.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: 'recognized', text: 'fixture' } as const;
        },
      }));
      const connector = new AzureSpeechConnector({
        ...baseOptions(),
        deployment: {
          kind: 'resource-endpoint',
          endpoint: 'https://speech-custom.example.invalid',
          networkAccess: 'all-networks',
        },
        authentication: {
          kind: 'microsoft-entra',
          resourceId: '/subscriptions/offline/resource',
          accessToken: 'offline-access-token',
        },
      });

      await collectEvents(
        connector.streamTranscription({
          locale: 'fi-FI',
          outputFormat: 'simple',
          contentType: 'audio/ogg; codecs=opus',
          audio: audioChunks(),
        }),
      );

      expect(connect.mock.calls[0][0]).toMatchObject({
        url: 'wss://speech-custom.example.invalid/stt/speech/recognition/conversation/cognitiveservices/v1?language=fi-FI&format=simple',
        authentication: {
          kind: 'microsoft-entra',
          resourceId: '/subscriptions/offline/resource',
          accessToken: 'offline-access-token',
        },
      });
    });

    it('rejects audio types outside the two documented WebSocket formats', async () => {
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(
        Promise.resolve().then(() =>
          collectEvents(
            connector.streamTranscription({
              locale: 'en-US',
              outputFormat: 'simple',
              contentType: 'audio/mpeg' as never,
              audio: audioChunks(),
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'UnsupportedStreamingAudioFormat' });
      expect(connect).not.toHaveBeenCalled();
    });
  });

  describe('text to speech and voice discovery', () => {
    it('synthesizes SSML with exact headers and returns audio bytes', async () => {
      const audio = new Uint8Array([79, 103, 103, 83]);
      httpTransport.mockResolvedValueOnce(
        new Response(audio, {
          status: 200,
          headers: { 'Content-Type': 'audio/ogg' },
        }),
      );
      const connector = new AzureSpeechConnector(baseOptions());
      const ssml =
        '<speak version="1.0" xml:lang="en-US"><voice name="en-US-AvaNeural">Hello</voice></speak>';

      const result = await connector.synthesizeSpeech({
        ssml,
        outputFormat: 'ogg-24khz-16bit-mono-opus',
        userAgent: 'model-connector-CONN-0301',
      });

      expect(result.audio).toEqual(audio);
      expect(result.contentType).toBe('audio/ogg');
      const [url, init] = httpTransport.mock.calls[0];
      expect(url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
      expect(init).toMatchObject({ method: 'POST', body: ssml });
      expect(init.headers).toEqual({
        'Content-Type': 'application/ssml+xml',
        'Ocp-Apim-Subscription-Key': 'offline-resource-key',
        'User-Agent': 'model-connector-CONN-0301',
        'X-Microsoft-OutputFormat': 'ogg-24khz-16bit-mono-opus',
      });
    });

    it('uses the /tts resource path and rejects invalid User-Agent lengths', async () => {
      const connector = new AzureSpeechConnector({
        ...baseOptions(),
        deployment: {
          kind: 'resource-endpoint',
          endpoint: 'https://speech-custom.example.invalid',
          networkAccess: 'all-networks',
        },
      });

      await expect(
        connector.synthesizeSpeech({
          ssml: '<speak version="1.0">fixture</speak>',
          outputFormat: 'riff-24khz-16bit-mono-pcm',
          userAgent: '',
        }),
      ).rejects.toMatchObject({ code: 'InvalidSynthesisInput' });
      await expect(
        connector.synthesizeSpeech({
          ssml: '<speak version="1.0">fixture</speak>',
          outputFormat: 'riff-24khz-16bit-mono-pcm',
          userAgent: 'x'.repeat(255),
        }),
      ).rejects.toMatchObject({ code: 'InvalidSynthesisInput' });
      expect(httpTransport).not.toHaveBeenCalled();

      httpTransport.mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        }),
      );
      await connector.synthesizeSpeech({
        ssml: '<speak version="1.0">fixture</speak>',
        outputFormat: 'riff-24khz-16bit-mono-pcm',
        userAgent: 'offline-test',
      });
      expect(httpTransport.mock.calls[0][0]).toBe(
        'https://speech-custom.example.invalid/tts/cognitiveservices/v1',
      );
    });

    it('discovers provider voices without filtering Preview status', async () => {
      const voices = fixture<Array<Record<string, unknown>>>('voices.json');
      httpTransport.mockResolvedValueOnce(jsonResponse(voices));
      const connector = new AzureSpeechConnector(baseOptions());

      const result = await connector.listVoices();

      expect(result).toEqual(voices);
      expect(httpTransport.mock.calls[0][0]).toBe(
        'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list',
      );
      expect(result.map((voice) => voice.Status)).toEqual(['GA', 'Preview']);
    });

    it('rejects a non-array voice response as a provider contract error', async () => {
      httpTransport.mockResolvedValueOnce(jsonResponse({ voices: [] }));
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(connector.listVoices()).rejects.toBeInstanceOf(AzureSpeechError);
      await expect(
        Promise.resolve().then(() => {
          throw new AzureSpeechError({
            statusCode: 200,
            code: 'InvalidProviderResponse',
            message: 'fixture',
            payload: { voices: [] },
          });
        }),
      ).rejects.toMatchObject({ code: 'InvalidProviderResponse' });
    });

    it('preserves a non-JSON provider error body', async () => {
      httpTransport.mockResolvedValueOnce(
        new Response('Unsupported output format', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
      const connector = new AzureSpeechConnector(baseOptions());

      await expect(
        connector.synthesizeSpeech({
          ssml: '<speak version="1.0">fixture</speak>',
          outputFormat: 'offline-invalid-format',
          userAgent: 'offline-test',
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'AzureSpeechHttpError',
        message: 'Unsupported output format',
        payload: 'Unsupported output format',
      });
    });
  });

  describe('capabilities', () => {
    it('declares exactly the five AU-044 operation families and conservative limits', () => {
      expect(AZURE_SPEECH_CAPABILITIES.provider).toBe('azure-speech');
      expect(AZURE_SPEECH_CAPABILITIES.operationFamilies).toEqual([
        'speech-to-text-fast',
        'speech-to-text-batch',
        'speech-to-text-streaming',
        'text-to-speech',
        'voice-discovery',
      ]);
      expect(AZURE_SPEECH_CAPABILITIES.speechToTextApiVersion).toBe('2025-10-15');
      expect(AZURE_SPEECH_CAPABILITIES.fast).toEqual({
        maxBytesExclusive: 250_000_000,
        maxDurationSecondsExclusive: 7_200,
        documentationBoundary: 'operation-reference-stricter-than-quota-page',
      });
      expect(AZURE_SPEECH_CAPABILITIES.batch).toMatchObject({
        states: ['NotStarted', 'Running', 'Succeeded', 'Failed'],
        maxContentUrls: 1_000,
        minimumPollingIntervalMs: 60_000,
        cancellation: 'delete-resource-no-separate-cancel',
        remoteContentLimits: {
          quotaMaxAudioInput: '1 GB',
          operationReferenceMaxContainer: '5 GB',
          operationReferenceMaxBlob: '2.5 GB',
          maxBlobsPerContainer: 10_000,
          enforcement: 'provider',
          documentationDrift: true,
        },
      });
      expect(AZURE_SPEECH_CAPABILITIES.streaming.transportBoundary).toBe(
        'injected-no-frame-claims',
      );
      expect(AZURE_SPEECH_CAPABILITIES.streaming).toMatchObject({
        supportedAudioContentTypes: [
          'audio/wav; codecs=audio/pcm; samplerate=16000',
          'audio/ogg; codecs=opus',
        ],
        generalSessionDurationLimit: 'not-documented',
      });
      expect(AZURE_SPEECH_CAPABILITIES.textToSpeech.maxOutputMinutes).toBe(10);
      expect(AZURE_SPEECH_CAPABILITIES.textToSpeech.maxDistinctVoiceAndAudioTags).toBe(50);
      expect(AZURE_SPEECH_CAPABILITIES.voiceDiscovery.staticCatalogue).toBe(false);
    });
  });
});
