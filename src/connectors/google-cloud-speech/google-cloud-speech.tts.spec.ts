import { describe, expect, it } from 'vitest';
import {
  collect,
  frames,
  loadFixture,
  RecordingHttpTransport,
  RecordingStreamingTransport,
} from '../../../test/fixtures/connectors/google-cloud-speech/recording-transports.fixture';
import { GoogleCloudTextToSpeechClient } from './google-cloud-speech.tts';

const auth = {
  getRequestHeaders: async () => ({
    authorization: 'Bearer synthetic-token',
    'x-goog-user-project': 'synthetic-quota-project',
  }),
};

const synthesizeResponse = loadFixture<Record<string, unknown>>('tts-synthesize.json');
const voicesResponse = loadFixture<Record<string, unknown>>('tts-voices.json');
const operationResponse = loadFixture<Record<string, unknown>>('tts-operation.json');
const streamingResponses = loadFixture<Record<string, unknown>[]>('tts-streaming-responses.json');

function createClient(
  httpResponses: unknown[] = [synthesizeResponse],
  streamResponses: unknown[] = streamingResponses,
  location = 'global',
) {
  const http = new RecordingHttpTransport(httpResponses);
  const streaming = new RecordingStreamingTransport(streamResponses);
  const client = new GoogleCloudTextToSpeechClient({
    auth,
    httpTransport: http,
    streamingTransport: streaming,
    location,
  });
  return { client, http, streaming };
}

describe('GoogleCloudTextToSpeechClient unary V1', () => {
  it('maps synchronous synthesis to V1 and preserves stable encoding', async () => {
    const { client, http } = createClient();
    const response = await client.synthesizeV1({
      input: { text: 'Synthetic fixture text' },
      voice: { languageCode: 'en-US', name: 'synthetic-fixture-voice' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1 },
    });

    expect(response).toEqual(synthesizeResponse);
    expect(http.requests).toEqual([
      {
        method: 'POST',
        url: 'https://texttospeech.googleapis.com/v1/text:synthesize',
        headers: {
          authorization: 'Bearer synthetic-token',
          'x-goog-user-project': 'synthetic-quota-project',
          'content-type': 'application/json',
        },
        body: {
          input: { text: 'Synthetic fixture text' },
          voice: { languageCode: 'en-US', name: 'synthetic-fixture-voice' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 1 },
        },
      },
    ]);
  });

  it('enforces synthesis input oneof, UTF-8 byte limit, and stable encoding catalog', async () => {
    const { client, http } = createClient();
    await expect(
      client.synthesizeV1({
        input: { text: 'text', ssml: '<speak>text</speak>' },
        voice: { languageCode: 'en-US' },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    ).rejects.toThrow(/exactly one.*text.*ssml/i);
    await expect(
      client.synthesizeV1({
        input: { text: 'é'.repeat(2_501) },
        voice: { languageCode: 'en-US' },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    ).rejects.toThrow(/5,000 bytes/i);
    await expect(
      client.synthesizeV1({
        input: { text: 'text' },
        voice: { languageCode: 'en-US' },
        audioConfig: { audioEncoding: 'PCM' },
      }),
    ).rejects.toThrow(/LINEAR16.*MP3.*OGG_OPUS.*MULAW.*ALAW/i);
    expect(http.requests).toHaveLength(0);
  });

  it('discovers voices through V1 without embedding a catalog', async () => {
    const { client, http } = createClient([voicesResponse]);
    const response = await client.listVoicesV1('en-US');

    expect(response).toEqual(voicesResponse);
    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://texttospeech.googleapis.com/v1/voices?languageCode=en-US',
    });
    expect(http.requests[0]?.body).toBeUndefined();
  });
});

describe('GoogleCloudTextToSpeechClient long audio', () => {
  const parent = 'projects/synthetic-project/locations/us-central1';
  const request = {
    parent,
    input: { text: 'Synthetic long audio text' },
    voice: { languageCode: 'en-US', name: 'synthetic-fixture-voice' },
    audioConfig: { audioEncoding: 'LINEAR16' as const },
    outputGcsUri: 'gs://synthetic-output/long-audio.wav',
  };

  it('uses the stable V1 route by default and matches location to endpoint', async () => {
    const { client, http } = createClient([operationResponse], streamingResponses, 'us-central1');
    const response = await client.synthesizeLongAudio(request);

    expect(response).toEqual(operationResponse);
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url:
        'https://us-central1-texttospeech.googleapis.com/v1/' +
        'projects/synthetic-project/locations/us-central1:synthesizeLongAudio',
      body: {
        input: request.input,
        voice: request.voice,
        audioConfig: request.audioConfig,
        outputGcsUri: request.outputGcsUri,
      },
    });
  });

  it('keeps V1beta1 explicit and separate from the stable route', async () => {
    const { client, http } = createClient([operationResponse], streamingResponses, 'us-central1');
    await client.synthesizeLongAudio({ ...request, version: 'v1beta1' });
    expect(http.requests[0]?.url).toContain('/v1beta1/');
  });

  it('requires a Cloud Storage output URI, matching location, and 1,000,000-byte input', async () => {
    const { client, http } = createClient([operationResponse], streamingResponses, 'us-central1');
    await expect(
      client.synthesizeLongAudio({ ...request, outputGcsUri: 'https://example.test/output.wav' }),
    ).rejects.toThrow(/gs:\/\//i);
    await expect(
      client.synthesizeLongAudio({
        ...request,
        parent: 'projects/synthetic-project/locations/europe-west4',
      }),
    ).rejects.toThrow(/parent location.*us-central1/i);
    await expect(
      client.synthesizeLongAudio({ ...request, input: { text: 'x'.repeat(1_000_001) } }),
    ).rejects.toThrow(/1,000,000 bytes/i);
    expect(http.requests).toHaveLength(0);
  });
});

describe('GoogleCloudTextToSpeechClient streaming Preview', () => {
  it('uses gRPC Preview with a config-only first frame and input-only later frames', async () => {
    const { client, streaming } = createClient();
    const response = await collect(
      client.streamingSynthesizeV1(
        frames([
          {
            streamingConfig: {
              voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
              streamingAudioConfig: { audioEncoding: 'PCM', sampleRateHertz: 24000 },
            },
          },
          { input: { text: 'Synthetic streaming text' } },
        ]),
      ),
    );

    expect(response).toEqual(streamingResponses);
    expect(streaming.calls[0]).toMatchObject({
      endpoint: 'texttospeech.googleapis.com',
      service: 'google.cloud.texttospeech.v1.TextToSpeech',
      method: 'StreamingSynthesize',
      metadata: {
        authorization: 'Bearer synthetic-token',
        'x-goog-user-project': 'synthetic-quota-project',
      },
    });
  });

  it('rejects non-Chirp 3 HD voices and unary-only encodings before streaming', async () => {
    const { client, streaming } = createClient();
    await expect(
      collect(
        client.streamingSynthesizeV1(
          frames([
            {
              streamingConfig: {
                voice: { languageCode: 'en-US', name: 'en-US-Standard-A' },
                streamingAudioConfig: { audioEncoding: 'MP3' },
              },
            },
            { input: { text: 'Synthetic streaming text' } },
          ]),
        ),
      ),
    ).rejects.toThrow(/Chirp 3 HD/i);
    expect(streaming.calls).toHaveLength(0);
  });

  it('rejects input before configuration and configuration repeated after handoff', async () => {
    const { client, streaming } = createClient();
    await expect(
      collect(
        client.streamingSynthesizeV1(frames([{ input: { text: 'Synthetic streaming text' } }])),
      ),
    ).rejects.toThrow(/first.*configuration/i);
    await expect(
      collect(
        client.streamingSynthesizeV1(
          frames([
            {
              streamingConfig: {
                voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
                streamingAudioConfig: { audioEncoding: 'PCM' },
              },
            },
            {
              streamingConfig: {
                voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
                streamingAudioConfig: { audioEncoding: 'PCM' },
              },
            },
          ]),
        ),
      ),
    ).rejects.toThrow(/subsequent.*input/i);
    expect(streaming.calls).toHaveLength(0);
  });

  it('rejects malformed streaming synthesis responses', async () => {
    const { client } = createClient([], [{ audioContent: 42 }]);
    await expect(
      collect(
        client.streamingSynthesizeV1(
          frames([
            {
              streamingConfig: {
                voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
                streamingAudioConfig: { audioEncoding: 'PCM' },
              },
            },
            { input: { text: 'Synthetic streaming text' } },
          ]),
        ),
      ),
    ).rejects.toThrow();
  });
});
