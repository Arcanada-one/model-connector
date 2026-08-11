import { describe, expect, it } from 'vitest';
import {
  collect,
  frames,
  loadFixture,
  RecordingHttpTransport,
  RecordingStreamingTransport,
} from '../../../test/fixtures/connectors/google-cloud-speech/recording-transports.fixture';
import { GoogleCloudSpeechToTextClient } from './google-cloud-speech.stt';

const auth = {
  getRequestHeaders: async () => ({ authorization: 'Bearer synthetic-token' }),
};

const v1Response = loadFixture<Record<string, unknown>>('stt-v1-recognize.json');
const v2Response = loadFixture<Record<string, unknown>>('stt-v2-recognize.json');
const v1Operation = loadFixture<Record<string, unknown>>('stt-v1-operation.json');
const v2Operation = loadFixture<Record<string, unknown>>('stt-v2-operation.json');
const streamingResponses = loadFixture<Record<string, unknown>[]>('stt-streaming-responses.json');

function createClient(
  httpResponses: unknown[] = [v1Response],
  streamResponses: unknown[] = streamingResponses,
  location = 'global',
) {
  const http = new RecordingHttpTransport(httpResponses);
  const streaming = new RecordingStreamingTransport(streamResponses);
  const client = new GoogleCloudSpeechToTextClient({
    auth,
    httpTransport: http,
    streamingTransport: streaming,
    location,
  });
  return { client, http, streaming };
}

describe('GoogleCloudSpeechToTextClient V1', () => {
  it('maps synchronous recognition to the global V1 REST contract', async () => {
    const { client, http } = createClient();
    const response = await client.recognizeV1({
      config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
      audio: { content: 'U1lOVEhFVElD' },
      audioDurationSeconds: 1,
    });

    expect(response).toEqual(v1Response);
    expect(http.requests).toEqual([
      {
        method: 'POST',
        url: 'https://speech.googleapis.com/v1/speech:recognize',
        headers: {
          authorization: 'Bearer synthetic-token',
          'content-type': 'application/json',
        },
        body: {
          config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' },
          audio: { content: 'U1lOVEhFVElD' },
        },
      },
    ]);
  });

  it('selects the documented us endpoint without changing the request version', async () => {
    const { client, http } = createClient([v1Response], streamingResponses, 'us');
    await client.recognizeV1({
      config: { languageCode: 'en-US' },
      audio: { uri: 'gs://synthetic-bucket/audio.wav' },
      audioDurationSeconds: 30,
    });
    expect(http.requests[0]?.url).toBe('https://us-speech.googleapis.com/v1/speech:recognize');
  });

  it('accepts unpadded protobuf-JSON base64 audio content', async () => {
    const { client, http } = createClient();
    await client.recognizeV1({
      config: { languageCode: 'en-US' },
      audio: { content: 'YQ' },
      audioDurationSeconds: 1,
    });
    expect(http.requests[0]?.body).toMatchObject({ audio: { content: 'YQ' } });
  });

  it('rejects invalid V1 synchronous audio oneof and duration before transport', async () => {
    const { client, http } = createClient();
    await expect(
      client.recognizeV1({
        config: { languageCode: 'en-US' },
        audio: { content: 'U1lO', uri: 'gs://synthetic-bucket/audio.wav' },
        audioDurationSeconds: 1,
      }),
    ).rejects.toThrow(/exactly one.*content.*uri/i);
    await expect(
      client.recognizeV1({
        config: { languageCode: 'en-US' },
        audio: { uri: 'gs://synthetic-bucket/audio.wav' },
        audioDurationSeconds: 61,
      }),
    ).rejects.toThrow(/60 seconds/i);
    expect(http.requests).toHaveLength(0);
  });

  it('requires duration evidence before V1 unary dispatch', async () => {
    const { client, http } = createClient();
    await expect(
      client.recognizeV1({
        config: { languageCode: 'en-US' },
        audio: { content: 'U1lO' },
      } as Parameters<typeof client.recognizeV1>[0]),
    ).rejects.toThrow(/duration.*required/i);
    await expect(
      client.longRunningRecognizeV1({
        config: { languageCode: 'en-US' },
        audio: { uri: 'gs://synthetic-bucket/audio.wav' },
      } as Parameters<typeof client.longRunningRecognizeV1>[0]),
    ).rejects.toThrow(/duration.*required/i);
    expect(http.requests).toHaveLength(0);
  });

  it('starts V1 long-running recognition and preserves the Cloud Storage URI', async () => {
    const { client, http } = createClient([v1Operation]);
    const response = await client.longRunningRecognizeV1({
      config: { languageCode: 'en-US' },
      audio: { uri: 'gs://synthetic-bucket/long-audio.flac' },
      audioDurationSeconds: 28_800,
    });

    expect(response).toEqual(v1Operation);
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://speech.googleapis.com/v1/speech:longrunningrecognize',
      body: {
        config: { languageCode: 'en-US' },
        audio: { uri: 'gs://synthetic-bucket/long-audio.flac' },
      },
    });
  });

  it('enforces the V1 streaming config handoff and 25 KB audio-message limit', async () => {
    const { client, streaming } = createClient();
    const response = await collect(
      client.streamingRecognizeV1(
        frames([
          { streamingConfig: { config: { languageCode: 'en-US' }, interimResults: true } },
          { audioContent: 'U1lOVEhFVElD' },
        ]),
        1,
      ),
    );

    expect(response).toEqual(streamingResponses);
    expect(streaming.calls[0]).toMatchObject({
      endpoint: 'speech.googleapis.com',
      service: 'google.cloud.speech.v1.Speech',
      method: 'StreamingRecognize',
      metadata: { authorization: 'Bearer synthetic-token' },
    });
    await expect(
      collect(
        client.streamingRecognizeV1(
          frames([
            { streamingConfig: { config: { languageCode: 'en-US' } } },
            { audioContent: Buffer.alloc(25 * 1024 + 1).toString('base64') },
          ]),
          1,
        ),
      ),
    ).rejects.toThrow(/25 KB/i);
    await expect(
      collect(
        client.streamingRecognizeV1(
          frames([
            { streamingConfig: { config: { languageCode: 'en-US' } } },
            { audioContent: 'U1lOVEhFVElD' },
          ]),
          301,
        ),
      ),
    ).rejects.toThrow(/300 seconds/i);
  });
});

describe('GoogleCloudSpeechToTextClient V2', () => {
  const recognizer = 'projects/synthetic-project/locations/us-central1/recognizers/_';

  it('maps synchronous V2 recognition to the recognizer regional endpoint', async () => {
    const { client, http } = createClient([v2Response], streamingResponses, 'us-central1');
    const response = await client.recognizeV2({
      recognizer,
      config: { autoDecodingConfig: {}, languageCodes: ['en-US'], model: 'long' },
      audio: { content: 'U1lOVEhFVElD' },
      audioDurationSeconds: 30,
    });

    expect(response).toEqual(v2Response);
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url:
        'https://us-central1-speech.googleapis.com/v2/' +
        'projects/synthetic-project/locations/us-central1/recognizers/_:recognize',
      body: {
        config: { autoDecodingConfig: {}, languageCodes: ['en-US'], model: 'long' },
        content: 'U1lOVEhFVElD',
      },
    });
  });

  it('requires a recognizer location matching the selected V2 endpoint', async () => {
    const { client, http } = createClient([v2Response], streamingResponses, 'europe-west4');
    await expect(
      client.recognizeV2({
        recognizer,
        config: { languageCodes: ['en-US'] },
        audio: { content: 'U1lOVEhFVElD' },
        audioDurationSeconds: 1,
      }),
    ).rejects.toThrow(/recognizer location.*europe-west4/i);
    expect(http.requests).toHaveLength(0);
  });

  it('rejects recognizer resource names with injected path segments', async () => {
    const { client, http } = createClient([v2Response], streamingResponses, 'us-central1');
    await expect(
      client.recognizeV2({
        recognizer:
          'projects/synthetic-project/locations/us-central1/recognizers/../recognizers/other',
        config: { languageCodes: ['en-US'] },
        audio: { content: 'U1lOVEhFVElD' },
        audioDurationSeconds: 1,
      }),
    ).rejects.toThrow(/invalid.*recognizer resource/i);
    expect(http.requests).toHaveLength(0);
  });

  it('starts V2 batch recognition with URI-only files and the current five-file ceiling', async () => {
    const { client, http } = createClient([v2Operation], streamingResponses, 'us-central1');
    const response = await client.batchRecognizeV2({
      recognizer,
      config: { languageCodes: ['en-US'], model: 'long' },
      files: [{ uri: 'gs://synthetic-bucket/audio-1.flac', audioDurationSeconds: 120 }],
      recognitionOutputConfig: { inlineResponseConfig: {} },
    });

    expect(response).toEqual(v2Operation);
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url:
        'https://us-central1-speech.googleapis.com/v2/' +
        'projects/synthetic-project/locations/us-central1/recognizers/_:batchRecognize',
      body: {
        config: { languageCodes: ['en-US'], model: 'long' },
        files: [{ uri: 'gs://synthetic-bucket/audio-1.flac' }],
        recognitionOutputConfig: { inlineResponseConfig: {} },
      },
    });
    await expect(
      client.batchRecognizeV2({
        recognizer,
        config: { languageCodes: ['en-US'] },
        files: Array.from({ length: 6 }, (_, index) => ({
          uri: `gs://synthetic-bucket/audio-${index}.flac`,
          audioDurationSeconds: 120,
        })),
        recognitionOutputConfig: { gcsOutputConfig: { uri: 'gs://synthetic-output/' } },
      }),
    ).rejects.toThrow(/maximum.*5 files/i);
  });

  it('enforces V2 batch output oneof, inline single-file scope, and eight-hour file limit', async () => {
    const { client, http } = createClient([v2Operation], streamingResponses, 'us-central1');
    const file = {
      uri: 'gs://synthetic-bucket/audio-1.flac',
      audioDurationSeconds: 120,
    };
    await expect(
      client.batchRecognizeV2({
        recognizer,
        files: [file],
        recognitionOutputConfig: {
          gcsOutputConfig: { uri: 'gs://synthetic-output/' },
          inlineResponseConfig: {},
        },
      }),
    ).rejects.toThrow(/exactly one.*gcsOutputConfig.*inlineResponseConfig/i);
    await expect(
      client.batchRecognizeV2({
        recognizer,
        files: [file],
        recognitionOutputConfig: {},
      }),
    ).rejects.toThrow(/exactly one.*gcsOutputConfig.*inlineResponseConfig/i);
    await expect(
      client.batchRecognizeV2({
        recognizer,
        files: [file, { ...file, uri: 'gs://synthetic-bucket/audio-2.flac' }],
        recognitionOutputConfig: { inlineResponseConfig: {} },
      }),
    ).rejects.toThrow(/inline.*one file/i);
    await expect(
      client.batchRecognizeV2({
        recognizer,
        files: [{ ...file, audioDurationSeconds: 28_801 }],
        recognitionOutputConfig: { gcsOutputConfig: { uri: 'gs://synthetic-output/' } },
      }),
    ).rejects.toThrow(/28,800 seconds/i);
    expect(http.requests).toHaveLength(0);
  });

  it('enforces the V2 configuration-first handoff and strict 15 KB frame limit', async () => {
    const { client, streaming } = createClient([v2Response], streamingResponses, 'us-central1');
    const response = await collect(
      client.streamingRecognizeV2(
        frames([
          {
            recognizer,
            streamingConfig: { config: { languageCodes: ['en-US'] } },
          },
          { audio: 'U1lOVEhFVElD' },
        ]),
      ),
    );

    expect(response).toEqual(streamingResponses);
    expect(streaming.calls[0]).toMatchObject({
      endpoint: 'us-central1-speech.googleapis.com',
      service: 'google.cloud.speech.v2.Speech',
      method: 'StreamingRecognize',
    });
    await expect(
      collect(
        client.streamingRecognizeV2(
          frames([
            { recognizer, streamingConfig: { config: { languageCodes: ['en-US'] } } },
            { audio: Buffer.alloc(15 * 1024 + 1).toString('base64') },
          ]),
        ),
      ),
    ).rejects.toThrow(/15 KB/i);
  });

  it('rejects V1 audio before the configuration frame', async () => {
    const { client, streaming } = createClient([], streamingResponses);
    await expect(
      collect(client.streamingRecognizeV1(frames([{ audioContent: 'U1lOVEhFVElD' }]), 1)),
    ).rejects.toThrow(/first.*configuration/i);
    expect(streaming.calls).toHaveLength(0);
  });

  it('accepts V2 audio-only frames for a fully configured recognizer', async () => {
    const { client, streaming } = createClient([], streamingResponses, 'us-central1');
    const response = await collect(
      client.streamingRecognizeV2(frames([{ audio: 'U1lOVEhFVElD' }])),
    );
    expect(response).toEqual(streamingResponses);
    expect(streaming.calls).toHaveLength(1);
  });

  it('requires duration evidence before V2 unary and batch dispatch', async () => {
    const { client, http } = createClient([v2Response], streamingResponses, 'us-central1');
    await expect(
      client.recognizeV2({
        recognizer,
        audio: { content: 'U1lOVEhFVElD' },
      } as Parameters<typeof client.recognizeV2>[0]),
    ).rejects.toThrow(/duration.*required/i);
    await expect(
      client.batchRecognizeV2({
        recognizer,
        files: [{ uri: 'gs://synthetic-bucket/audio.flac' }],
        recognitionOutputConfig: { inlineResponseConfig: {} },
      } as Parameters<typeof client.batchRecognizeV2>[0]),
    ).rejects.toThrow(/duration.*required/i);
    expect(http.requests).toHaveLength(0);
  });

  it('rejects malformed streaming recognition responses', async () => {
    const { client } = createClient([], [{ results: 'not-an-array' }], 'us-central1');
    await expect(
      collect(
        client.streamingRecognizeV2(
          frames([
            { recognizer, streamingConfig: { config: { languageCodes: ['en-US'] } } },
            { audio: 'U1lOVEhFVElD' },
          ]),
        ),
      ),
    ).rejects.toThrow();
  });
});
