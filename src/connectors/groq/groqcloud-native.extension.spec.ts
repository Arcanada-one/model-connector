import { describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/groqcloud-native.placeholder.json';
import {
  GroqCloudNativeExtension,
  type GroqCloudTransport,
  type GroqCloudTransportRequest,
} from './groqcloud-native.extension';
import { GroqConnector } from './groq.connector';

const BASE_URL = 'https://api.groq.com/openai/v1';
const TEST_BEARER = 'test-key';

function transportWith(body: unknown, status = 200) {
  const request = vi.fn(async (_input: GroqCloudTransportRequest) => ({ status, body }));
  return { transport: { request } satisfies GroqCloudTransport, request };
}

function extension(body: unknown = fixture.response, status = 200) {
  const mocked = transportWith(body, status);
  return {
    connector: new GroqCloudNativeExtension(
      { baseUrl: BASE_URL, apiKey: TEST_BEARER, timeoutMs: 12_000 },
      mocked.transport,
    ),
    request: mocked.request,
  };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('inherited Groq behavior (unchanged)', () => {
  it('retains the committed chat capability identity and model discovery method', () => {
    const inherited = new GroqConnector();
    expect(inherited.getCapabilities()).toMatchObject({ name: 'groq', type: 'api' });
    expect(typeof inherited.refreshModels).toBe('function');
  });
});

describe('new AU-022 GroqCloud native extension', () => {
  it('requires the exact hosted base and a non-empty bearer value', () => {
    const transport = transportWith({}).transport;
    expect(
      () =>
        new GroqCloudNativeExtension(
          { baseUrl: 'http://api.groq.com/openai/v1', apiKey: 'x' },
          transport,
        ),
    ).toThrow('canonical GroqCloud endpoint');
    expect(
      () => new GroqCloudNativeExtension({ baseUrl: BASE_URL, apiKey: ' ' }, transport),
    ).toThrow('non-empty');
  });

  it('creates a buffered Responses request with exact auth/path/body', async () => {
    const { connector, request } = extension();
    await expect(
      connector.createResponse({ model: 'openai/gpt-oss-20b', input: 'hello' }),
    ).resolves.toEqual(fixture.response);
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/responses',
      headers: { Authorization: `Bearer ${TEST_BEARER}`, 'Content-Type': 'application/json' },
      body: { model: 'openai/gpt-oss-20b', input: 'hello', stream: false },
      contentType: 'application/json',
      stream: false,
      timeoutMs: 12_000,
    });
  });

  it('passes documented Responses tools through unchanged', async () => {
    const tools = [
      {
        type: 'function',
        name: 'lookup_weather',
        description: 'Look up weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ];
    const buffered = extension();
    await buffered.connector.createResponse({ model: 'openai/gpt-oss-20b', input: 'hello', tools });
    expect(buffered.request.mock.calls[0][0].body).toEqual({
      model: 'openai/gpt-oss-20b',
      input: 'hello',
      tools,
      stream: false,
    });

    const streamed = extension(
      'data: {"type":"response.completed","response":{"id":"resp_placeholder"}}\n\n',
    );
    await collect(
      streamed.connector.streamResponse({ model: 'openai/gpt-oss-20b', input: 'hello', tools }),
    );
    expect(streamed.request.mock.calls[0][0].body).toEqual({
      model: 'openai/gpt-oss-20b',
      input: 'hello',
      tools,
      stream: true,
    });
  });

  it('keeps chat SSE terminated by [DONE]', async () => {
    async function* chatBody() {
      yield 'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n';
      yield 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n';
    }
    const chat = extension(chatBody());
    await expect(
      collect(
        chat.connector.streamChat({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    ).resolves.toEqual(['hel', 'lo']);
    expect(chat.request.mock.calls[0][0]).toMatchObject({
      path: '/chat/completions',
      stream: true,
    });
  });

  it('terminates Responses SSE at response.completed without [DONE]', async () => {
    const responses = extension(
      'data: {"type":"response.output_text.delta","delta":"A"}\n\n' +
        'data: {"type":"response.completed","response":{"id":"resp_placeholder"}}\n\n',
    );
    await expect(
      collect(responses.connector.streamResponse({ model: 'openai/gpt-oss-20b', input: 'hi' })),
    ).resolves.toEqual(['A']);
  });

  it('rejects post-terminal and truncated Responses SSE', async () => {
    await expect(
      collect(
        extension(
          'data: {"type":"response.completed","response":{"id":"resp_placeholder"}}\n\n' +
            'data: {"type":"response.output_text.delta","delta":"late"}\n\n',
        ).connector.streamResponse({ model: 'openai/gpt-oss-20b', input: 'hi' }),
      ),
    ).rejects.toThrow('after response.completed');
    await expect(
      collect(
        extension(
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        ).connector.streamResponse({
          model: 'openai/gpt-oss-20b',
          input: 'hi',
        }),
      ),
    ).rejects.toThrow('without response.completed');
  });

  it('rejects truncated, malformed, and post-DONE SSE', async () => {
    await expect(
      collect(
        extension('data: {"choices":[]}\n\n').connector.streamChat({ model: 'm', messages: [{}] }),
      ),
    ).rejects.toThrow();
    await expect(
      collect(
        extension(
          'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"late"}}]}\n\n',
        ).connector.streamChat({
          model: 'm',
          messages: [{}],
        }),
      ),
    ).rejects.toThrow('after DONE');
  });

  it('maps translation multipart and speech binary operations', async () => {
    const audio = {
      filename: 'sample.wav',
      contentType: 'audio/wav' as const,
      data: new Uint8Array([1, 2]),
    };
    const translation = extension(fixture.translation);
    await expect(
      translation.connector.translateAudio({ model: 'whisper-large-v3', file: audio }),
    ).resolves.toEqual(fixture.translation);
    expect(translation.request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path: '/audio/translations',
      contentType: 'multipart/form-data',
      body: { model: 'whisper-large-v3', file: audio },
    });

    const bytes = new Uint8Array([82, 73, 70, 70]);
    const speech = extension(bytes);
    await expect(
      speech.connector.createSpeech({
        model: 'canopylabs/orpheus-v1-english',
        input: 'hello',
        voice: 'austin',
      }),
    ).resolves.toEqual(bytes);
    expect(speech.request.mock.calls[0][0]).toMatchObject({
      path: '/audio/speech',
      contentType: 'application/json',
    });
  });

  it('retrieves model detail without inventing model catalogue fields', async () => {
    const { connector, request } = extension(fixture.model);
    await expect(connector.retrieveModel('model-placeholder')).resolves.toEqual(fixture.model);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: '/models/model-placeholder',
    });
  });

  it('covers create, retrieve, list, and cancel batch lifecycle', async () => {
    const cases: Array<[() => Promise<unknown>, string, string]> = [];
    const created = extension(fixture.batch);
    cases.push([
      () =>
        created.connector.createBatch({
          input_file_id: 'file_placeholder',
          endpoint: '/v1/chat/completions',
          completion_window: '24h',
        }),
      'POST',
      '/batches',
    ]);
    const retrieved = extension(fixture.batch);
    cases.push([
      () => retrieved.connector.retrieveBatch('batch_placeholder'),
      'GET',
      '/batches/batch_placeholder',
    ]);
    const listed = extension({ object: 'list', data: [fixture.batch] });
    cases.push([() => listed.connector.listBatches(), 'GET', '/batches']);
    const cancelled = extension(fixture.batch);
    cases.push([
      () => cancelled.connector.cancelBatch('batch_placeholder'),
      'POST',
      '/batches/batch_placeholder/cancel',
    ]);
    const requests = [created.request, retrieved.request, listed.request, cancelled.request];
    for (let index = 0; index < cases.length; index++) {
      const [call, method, path] = cases[index];
      await call();
      expect(requests[index].mock.calls[0][0]).toMatchObject({ method, path });
    }
  });

  it('covers upload, list, delete, retrieve, and content file lifecycle', async () => {
    const upload = extension(fixture.file);
    const file = {
      filename: 'batch.jsonl',
      contentType: 'application/jsonl' as const,
      data: new Uint8Array([123, 125]),
    };
    await upload.connector.uploadFile(file);
    expect(upload.request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path: '/files',
      contentType: 'multipart/form-data',
    });

    const operations: Array<[keyof GroqCloudNativeExtension, string, string, unknown]> = [
      ['listFiles', 'GET', '/files', { object: 'list', data: [fixture.file] }],
      [
        'deleteFile',
        'DELETE',
        '/files/file_placeholder',
        { id: 'file_placeholder', object: 'file', deleted: true },
      ],
      ['retrieveFile', 'GET', '/files/file_placeholder', fixture.file],
      ['downloadFile', 'GET', '/files/file_placeholder/content', new Uint8Array([1, 2, 3])],
    ];
    for (const [methodName, method, path, body] of operations) {
      const current = extension(body);
      const fn = current.connector[methodName] as (id?: string) => Promise<unknown>;
      await fn.call(current.connector, methodName === 'listFiles' ? undefined : 'file_placeholder');
      expect(current.request.mock.calls[0][0]).toMatchObject({ method, path });
    }
  });

  it('validates identifiers and required bodies before transport', async () => {
    const { connector, request } = extension();
    expect(() => connector.retrieveModel('../secret')).toThrow('identifier');
    expect(() => connector.createResponse({ input: 'missing model' })).toThrow('model');
    expect(() =>
      connector.createBatch({
        input_file_id: 'file',
        endpoint: '/other',
        completion_window: '24h',
      }),
    ).toThrow('endpoint');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth_error'],
    [403, 'auth_error'],
    [408, 'timeout'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [422, 'validation_error'],
  ])('maps HTTP %i to safe %s without bearer leakage', async (status, type) => {
    const { connector } = extension(fixture.error, status);
    await expect(connector.retrieveModel('model-placeholder')).rejects.toThrow(
      `${type}: GroqCloud request failed (HTTP ${status}`,
    );
    await expect(connector.retrieveModel('model-placeholder')).rejects.not.toThrow(TEST_BEARER);
  });
});
