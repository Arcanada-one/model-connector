import { describe, expect, it } from 'vitest';
import {
  loadFixture,
  RecordingHttpTransport,
} from '../../../test/fixtures/connectors/google-cloud-speech/recording-transports.fixture';
import {
  GoogleCloudSpeechOperationError,
  GoogleCloudSpeechOperationsClient,
} from './google-cloud-speech.operations';

const auth = {
  getRequestHeaders: async () => ({ authorization: 'Bearer synthetic-token' }),
};

const pending = loadFixture<Record<string, unknown>>('operation-pending.json');
const done = loadFixture<Record<string, unknown>>('operation-done.json');
const failed = loadFixture<Record<string, unknown>>('operation-error.json');
const v1Started = loadFixture<Record<string, unknown>>('stt-v1-operation.json');
const apiError = loadFixture<Record<string, unknown>>('google-api-error.json');

function createClient(responses: unknown[]) {
  const http = new RecordingHttpTransport(responses);
  return {
    http,
    client: new GoogleCloudSpeechOperationsClient({ auth, httpTransport: http }),
  };
}

describe('GoogleCloudSpeechOperationsClient polling', () => {
  it.each([
    {
      api: 'speech-v1' as const,
      name: 'operations/1234567890123456789',
      url: 'https://speech.googleapis.com/v1/operations/1234567890123456789',
    },
    {
      api: 'speech-v2' as const,
      name: 'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
      url:
        'https://us-central1-speech.googleapis.com/v2/' +
        'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
    },
    {
      api: 'speech-v2' as const,
      name: 'projects/123456789012/locations/us-central1/operations/1234567890123456789',
      url:
        'https://us-central1-speech.googleapis.com/v2/' +
        'projects/123456789012/locations/us-central1/operations/1234567890123456789',
    },
    {
      api: 'tts-v1' as const,
      name: 'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
      url:
        'https://us-central1-texttospeech.googleapis.com/v1/' +
        'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
    },
    {
      api: 'tts-v1beta1' as const,
      name: 'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
      url:
        'https://us-central1-texttospeech.googleapis.com/v1beta1/' +
        'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
    },
  ])('polls $api with its service/version-aware operation path', async ({ api, name, url }) => {
    const { client, http } = createClient([pending]);
    const operation = await client.getOperation({ api, name });
    expect(operation).toEqual(pending);
    expect(http.requests[0]).toMatchObject({ method: 'GET', url });
  });

  it('preserves typed metadata and response payloads on completed operations', async () => {
    const { client } = createClient([done]);
    const operation = await client.getOperation({
      api: 'speech-v2',
      name: 'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
    });
    expect(operation.done).toBe(true);
    expect(operation.metadata).toMatchObject({ progressPercent: 100 });
    expect(operation.response).toMatchObject({
      '@type': 'type.googleapis.com/google.cloud.speech.v2.BatchRecognizeResponse',
    });
  });

  it('preserves the V1 operations/** wildcard for safe nested operation names', async () => {
    const { client, http } = createClient([pending]);
    await client.getOperation({
      api: 'speech-v1',
      name: 'operations/archive/1234567890123456789',
    });
    expect(http.requests[0]?.url).toBe(
      'https://speech.googleapis.com/v1/operations/archive/1234567890123456789',
    );
  });

  it('polls the exact operation resource returned by V1 long-running recognition', async () => {
    const { client, http } = createClient([pending]);
    await client.getOperation({
      api: 'speech-v1',
      name: String(v1Started.name),
    });
    expect(http.requests[0]?.url).toBe(
      'https://speech.googleapis.com/v1/operations/1234567890123456789',
    );
  });

  it.each([
    {
      name: 'pending operation with a response',
      value: { name: 'operations/invalid', done: false, response: {} },
    },
    {
      name: 'completed operation with both results',
      value: {
        name: 'operations/invalid',
        done: true,
        response: {},
        error: { code: 1, message: 'invalid' },
      },
    },
    {
      name: 'completed operation without a result',
      value: { name: 'operations/invalid', done: true },
    },
  ])('rejects an invalid LRO lifecycle: $name', async ({ value }) => {
    const { client } = createClient([value]);
    await expect(
      client.getOperation({ api: 'speech-v1', name: 'operations/invalid' }),
    ).rejects.toThrow();
  });

  it('throws a typed error carrying google.rpc.Status for a failed operation', async () => {
    const { client } = createClient([failed]);
    const result = client.getOperation({
      api: 'speech-v2',
      name: 'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
    });
    await expect(result).rejects.toBeInstanceOf(GoogleCloudSpeechOperationError);
    await expect(result).rejects.toMatchObject({
      status: {
        code: 3,
        message: 'Synthetic invalid request',
        details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest' }],
      },
    });
  });
});

describe('GoogleCloudSpeechOperationsClient cancellation', () => {
  it('posts best-effort cancellation and accepts the documented empty response', async () => {
    const { client, http } = createClient([{}]);
    await expect(
      client.cancelOperation({
        api: 'speech-v2',
        name: 'projects/synthetic-project/locations/us-central1/operations/1234567890123456789',
      }),
    ).resolves.toEqual({});
    expect(http.requests[0]).toMatchObject({
      method: 'POST',
      url:
        'https://us-central1-speech.googleapis.com/v2/' +
        'projects/synthetic-project/locations/us-central1/operations/' +
        '1234567890123456789:cancel',
      body: {},
    });
  });

  it('rejects operation names that do not belong to the declared API shape', async () => {
    const { client, http } = createClient([pending]);
    await expect(
      client.getOperation({
        api: 'speech-v1',
        name: 'projects/synthetic-project/locations/us-central1/operations/123',
      }),
    ).rejects.toThrow(/speech-v1.*operations\//i);
    await expect(
      client.getOperation({
        api: 'speech-v1',
        name: 'operations/../synthetic-target',
      }),
    ).rejects.toThrow(/speech-v1.*operations\//i);
    expect(http.requests).toHaveLength(0);
  });

  it('maps a non-2xx Google REST envelope without losing google.rpc details', async () => {
    const transport = {
      request: async () => ({
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: apiError,
      }),
    };
    const client = new GoogleCloudSpeechOperationsClient({
      auth,
      httpTransport: transport,
    });
    const result = client.getOperation({
      api: 'speech-v1',
      name: 'operations/1234567890123456789',
    });
    await expect(result).rejects.toMatchObject({
      httpStatus: 400,
      status: 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest' }],
    });
  });
});
