import { readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  ZaiGlobalConnector,
  type ZaiGlobalTransport,
  type ZaiGlobalTransportRequest,
} from './zai-global.connector';

interface Fixture<T> {
  fixture_provenance: string;
  payload: T;
}

interface PayloadFixture<T> {
  fixture_provenance: string;
  payloads: T;
}

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', name), 'utf8')) as T;

const chatFixture = fixture<Fixture<Record<string, unknown>>>('chat-success.placeholder.json');
const operationFixture = fixture<
  PayloadFixture<Record<string, Record<string, unknown>>>
>('operation-results.placeholder.json');
const errorFixture = fixture<PayloadFixture<Record<string, Record<string, unknown>>>>(
  'errors.placeholder.json',
);
const chatSse = readFileSync(
  resolve(__dirname, '__fixtures__', 'chat-stream.placeholder.sse'),
  'utf8',
);
const audioSse = readFileSync(
  resolve(__dirname, '__fixtures__', 'audio-stream.placeholder.sse'),
  'utf8',
);

async function* chunked(value: string): AsyncGenerator<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  for (const end of [17, 61, 109, encoded.length]) {
    const start = end === 17 ? 0 : [17, 61, 109][[17, 61, 109, encoded.length].indexOf(end) - 1];
    if (start < encoded.length) yield encoded.slice(start, Math.min(end, encoded.length));
  }
}

describe('ZaiGlobalConnector AU-021 frozen global boundary', () => {
  let request: Mock<ZaiGlobalTransport['request']>;
  let transport: ZaiGlobalTransport;

  const create = (overrides: Partial<{ baseUrl: string; apiKey: string; timeoutMs: number }> = {}) =>
    new ZaiGlobalConnector(
      {
        baseUrl: 'https://api.z.ai/api/paas/v4',
        apiKey: 'zai_synthetic_secret',
        ...overrides,
      },
      transport,
    );

  beforeEach(() => {
    request = vi.fn<ZaiGlobalTransport['request']>();
    transport = { request };
  });

  it('fixtures are explicitly synthetic placeholders', () => {
    expect(chatFixture.fixture_provenance).toBe('synthetic_placeholder_not_live_provider_data');
    expect(operationFixture.fixture_provenance).toBe(
      'synthetic_placeholder_not_live_provider_data',
    );
    expect(errorFixture.fixture_provenance).toBe('synthetic_placeholder_not_live_provider_data');
    expect(chatSse).toContain('synthetic_placeholder_not_live_provider_data');
    expect(audioSse).toContain('synthetic_placeholder_not_live_provider_data');
  });

  it('requires the exact global HTTPS /api/paas/v4 base', () => {
    for (const baseUrl of [
      'https://open.bigmodel.cn/api/paas/v4',
      'https://api.z.ai/api/coding/paas/v4',
      'http://api.z.ai/api/paas/v4',
      'https://user:pass@api.z.ai/api/paas/v4',
      'https://api.z.ai/api/paas/v4?region=cn',
    ]) {
      expect(() => create({ baseUrl })).toThrow(/canonical Z\.AI global/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('requires a non-empty opaque bearer value and bounded timeout', () => {
    expect(() => create({ apiKey: '  ' })).toThrow(/bearer value/);
    expect(() => create({ timeoutMs: 999 })).toThrow(/timeout/);
    expect(() => create({ timeoutMs: 300_001 })).toThrow(/timeout/);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not invoke transport during construction, status, or capability inspection', async () => {
    const connector = create();
    expect(connector.getCapabilities().name).toBe('zai-global');
    await expect(connector.getStatus()).resolves.toMatchObject({ healthy: true, activeJobs: 0 });
    expect(request).not.toHaveBeenCalled();
  });

  it('advertises only documented chat models and implemented capabilities', () => {
    const capabilities = create().getCapabilities();
    expect(capabilities).toMatchObject({
      name: 'zai-global',
      type: 'api',
      supportsStreaming: true,
      supportsJsonSchema: false,
      supportsTools: false,
      modality: 'chat',
    });
    expect(capabilities.models).toEqual([
      'glm-5.2',
      'glm-5.1',
      'glm-5-turbo',
      'glm-5',
      'glm-4.7',
      'glm-4.7-flash',
      'glm-4.7-flashx',
      'glm-4.6',
      'glm-4.5',
      'glm-4.5-air',
      'glm-4.5-x',
      'glm-4.5-airx',
      'glm-4.5-flash',
      'glm-4-32b-0414-128k',
    ]);
  });

  it('maps non-streaming chat through the exact global path and bearer header', async () => {
    request.mockResolvedValueOnce({ status: 200, body: chatFixture.payload });
    const response = await create().execute({
      model: 'glm-5.2',
      prompt: 'synthetic prompt',
      systemPrompt: 'synthetic system',
      responseFormat: { type: 'json_object' },
      extra: { max_tokens: 100, temperature: 0.4, top_p: 0.8 },
    });

    const sent = request.mock.calls[0][0] as ZaiGlobalTransportRequest;
    expect(sent).toMatchObject({
      method: 'POST',
      path: '/chat/completions',
      contentType: 'application/json',
      stream: false,
      headers: {
        Authorization: 'Bearer zai_synthetic_secret',
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      body: {
        model: 'glm-5.2',
        messages: [
          { role: 'system', content: 'synthetic system' },
          { role: 'user', content: 'synthetic prompt' },
        ],
        stream: false,
        response_format: { type: 'json_object' },
        max_tokens: 100,
        temperature: 0.4,
        top_p: 0.8,
      },
    });
    expect(response).toMatchObject({
      connector: 'zai-global',
      model: 'glm-5.2',
      result: 'synthetic response',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, costUsd: 0 },
      status: 'success',
    });
  });

  it('forwards ordered text/image blocks without widening the shared modality union', async () => {
    request.mockResolvedValueOnce({ status: 200, body: chatFixture.payload });
    const blocks = [
      { type: 'text' as const, text: 'inspect' },
      { type: 'image_url' as const, image_url: { url: 'https://example.invalid/a.png' } },
    ];
    await create().execute({ model: 'glm-5.2', prompt: blocks });
    expect((request.mock.calls[0][0] as ZaiGlobalTransportRequest).body).toMatchObject({
      messages: [{ role: 'user', content: blocks }],
    });
  });

  it('rejects unrepresentable tools and undocumented json_schema before transport', async () => {
    const connector = create();
    await expect(
      connector.execute({ model: 'glm-5.2', prompt: 'x', tools: ['synthetic_tool'] }),
    ).resolves.toMatchObject({ status: 'error', error: { type: 'validation_error' } });
    await expect(
      connector.execute({ model: 'glm-5.2', prompt: 'x', jsonSchema: { type: 'object' } }),
    ).resolves.toMatchObject({ status: 'error', error: { type: 'validation_error' } });
    expect(request).not.toHaveBeenCalled();
  });

  it('decodes chunked chat SSE and requires [DONE]', async () => {
    request.mockResolvedValueOnce({ status: 200, body: chunked(chatSse) });
    const deltas: string[] = [];
    for await (const delta of create().streamChat({ model: 'glm-5.2', prompt: 'x' })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(['synthetic ', 'stream']);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path: '/chat/completions',
      stream: true,
      body: { stream: true },
    });
  });

  it('rejects a chat SSE stream that ends without [DONE]', async () => {
    request.mockResolvedValueOnce({
      status: 200,
      body: chunked('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    });
    const consume = async () => {
      for await (const delta of create().streamChat({ model: 'glm-5.2', prompt: 'x' })) {
        expect(delta).toBe('partial');
      }
    };
    await expect(consume()).rejects.toThrow(/without.*DONE/);
  });

  it('maps multipart audio transcription and validates file presence', async () => {
    request.mockResolvedValueOnce({ status: 200, body: operationFixture.payloads.audio });
    const response = await create().transcribe({
      model: 'glm-asr-2512',
      file: {
        filename: 'synthetic.wav',
        contentType: 'audio/wav',
        data: new Uint8Array([1, 2, 3]),
      },
      prompt: 'synthetic context',
    });
    expect(response).toEqual(operationFixture.payloads.audio);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path: '/audio/transcriptions',
      contentType: 'multipart/form-data',
      stream: false,
      body: { model: 'glm-asr-2512', prompt: 'synthetic context', stream: false },
    });
    await expect(create().transcribe({ model: 'glm-asr-2512' })).rejects.toThrow(
      /file or file_base64/,
    );
  });

  it('decodes audio transcription SSE deltas and requires [DONE]', async () => {
    request.mockResolvedValueOnce({ status: 200, body: chunked(audioSse) });
    const deltas: string[] = [];
    for await (const delta of create().streamTranscription({
      model: 'glm-asr-2512',
      fileBase64: 'c3ludGhldGlj',
    })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(['synthetic ', 'audio']);
    expect(request.mock.calls[0][0]).toMatchObject({
      path: '/audio/transcriptions',
      contentType: 'multipart/form-data',
      stream: true,
      body: { model: 'glm-asr-2512', file_base64: 'c3ludGhldGlj', stream: true },
    });
  });

  it.each([
    ['generateImage', '/images/generations', 'image', { model: 'glm-image', prompt: 'x' }],
    [
      'generateImageAsync',
      '/async/images/generations',
      'asyncImage',
      { model: 'glm-image', prompt: 'x' },
    ],
    ['generateVideo', '/videos/generations', 'video', { model: 'cogvideox-3', prompt: 'x' }],
    ['tokenize', '/tokenizer', 'tokenizer', { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] }],
    ['parseLayout', '/layout_parsing', 'layout', { model: 'glm-ocr', file: 'https://example.invalid/a.pdf' }],
    ['webSearch', '/web_search', 'search', { search_engine: 'search-prime', search_query: 'x' }],
    ['readWeb', '/reader', 'reader', { url: 'https://example.invalid' }],
  ] as const)('forwards %s only through exact path %s', async (method, path, payloadKey, body) => {
    request.mockResolvedValueOnce({ status: 200, body: operationFixture.payloads[payloadKey] });
    const connector = create() as unknown as Record<
      string,
      (input: Record<string, unknown>) => Promise<unknown>
    >;
    await expect(connector[method](body)).resolves.toEqual(operationFixture.payloads[payloadKey]);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path,
      contentType: 'application/json',
      body,
    });
  });

  it('retrieves async image/video lifecycle by a safely encoded task ID', async () => {
    request.mockResolvedValueOnce({ status: 200, body: operationFixture.payloads.asyncResult });
    await expect(create().getAsyncResult('task_synthetic-01')).resolves.toEqual(
      operationFixture.payloads.asyncResult,
    );
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: '/async-result/task_synthetic-01',
    });
    await expect(create().getAsyncResult('../agents')).rejects.toThrow(/task ID/);
  });

  it.each([
    [401, 'auth', 'auth_error'],
    [429, 'balance', 'billing_error'],
    [400, 'model', 'model_not_found'],
    [500, 'network', 'network_error'],
    [429, 'rate', 'rate_limited'],
  ] as const)('classifies HTTP/business error %s/%s as %s', async (status, key, type) => {
    request.mockResolvedValueOnce({ status, body: errorFixture.payloads[key] });
    const response = await create().execute({ model: 'glm-5.2', prompt: 'x' });
    expect(response).toMatchObject({ error: { type } });
  });

  it('never propagates bearer material from provider error text', async () => {
    request.mockResolvedValueOnce({
      status: 401,
      body: {
        code: 1000,
        message: 'Bearer zai_synthetic_secret rejected; zai_synthetic_secret is invalid',
      },
    });
    const response = await create().execute({ model: 'glm-5.2', prompt: 'x' });
    expect(JSON.stringify(response)).not.toContain('zai_synthetic_secret');
    expect(response.error?.message).toContain('Z.AI request failed');
  });

  it('rejects malformed success payloads as parse_error', async () => {
    request.mockResolvedValueOnce({ status: 200, body: { choices: [] } });
    await expect(create().execute({ model: 'glm-5.2', prompt: 'x' })).resolves.toMatchObject({
      status: 'error',
      error: { type: 'parse_error' },
    });
  });
});
