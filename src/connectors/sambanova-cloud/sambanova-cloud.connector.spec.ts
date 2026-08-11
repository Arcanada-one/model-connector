import { readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SambaNovaCloudConnector,
  SambaNovaTransport,
  SambaNovaTransportRequest,
} from './sambanova-cloud.connector';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', name), 'utf8')) as unknown;

const chatSuccess = fixture('chat-success.placeholder.json');
const modelsSuccess = fixture('models-success.placeholder.json');
const providerError = fixture('error.placeholder.json');
const streamSuccess = readFileSync(
  resolve(__dirname, '__fixtures__', 'stream-success.placeholder.sse'),
  'utf8',
);

const chunked = async function* (value: string, cuts: number[]): AsyncGenerator<string> {
  let offset = 0;
  for (const cut of cuts) {
    yield value.slice(offset, cut);
    offset = cut;
  }
  yield value.slice(offset);
};

describe('SambaNovaCloudConnector', () => {
  let request: ReturnType<typeof vi.fn<SambaNovaTransport['request']>>;
  let transport: SambaNovaTransport;
  let connector: SambaNovaCloudConnector;

  beforeEach(() => {
    request = vi.fn<SambaNovaTransport['request']>();
    transport = { request };
    connector = new SambaNovaCloudConnector(
      {
        baseUrl: 'https://api.sambanova.ai/v1',
        apiKey: 'placeholder-test-key',
        timeoutMs: 12_000,
      },
      transport,
    );
  });

  it('does not invoke transport during construction, status, or capability reads', async () => {
    connector.getCapabilities();
    await connector.getStatus();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'http://api.sambanova.ai/v1',
    'https://example.com/v1',
    'https://user@api.sambanova.ai/v1',
    'https://api.sambanova.ai/v2',
    'https://api.sambanova.ai/v1?query=1',
    'https://api.sambanova.ai/v1#fragment',
  ])('rejects a non-canonical hosted base before transport: %s', (baseUrl) => {
    expect(
      () =>
        new SambaNovaCloudConnector(
          { baseUrl, apiKey: 'placeholder-test-key', timeoutMs: 12_000 },
          transport,
        ),
    ).toThrow('SambaNova Cloud base URL');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an empty API key before transport without echoing it', () => {
    expect(
      () =>
        new SambaNovaCloudConnector(
          { baseUrl: 'https://api.sambanova.ai/v1', apiKey: '   ', timeoutMs: 12_000 },
          transport,
        ),
    ).toThrow('API key');
    expect(request).not.toHaveBeenCalled();
  });

  it('sends an exact non-streaming chat request through the injected transport', async () => {
    request.mockResolvedValueOnce({ status: 200, body: chatSuccess });
    await connector.execute({
      model: 'placeholder-model',
      systemPrompt: 'system placeholder',
      prompt: 'user placeholder',
      responseFormat: { type: 'json_object' },
      extra: { max_tokens: 20, temperature: 0.2, top_p: 0.9, top_k: 4, stop: ['END'] },
    });

    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0] as SambaNovaTransportRequest;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/chat/completions');
    expect(sent.headers).toEqual({
      Authorization: 'Bearer placeholder-test-key',
      'Content-Type': 'application/json',
    });
    expect(sent.timeoutMs).toBe(12_000);
    expect(sent.body).toEqual({
      model: 'placeholder-model',
      messages: [
        { role: 'system', content: 'system placeholder' },
        { role: 'user', content: 'user placeholder' },
      ],
      stream: false,
      response_format: { type: 'json_object' },
      max_tokens: 20,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 4,
      stop: ['END'],
    });
  });

  it('maps a valid placeholder response into the shared connector response', async () => {
    request.mockResolvedValueOnce({ status: 200, body: chatSuccess });
    const result = await connector.execute({ prompt: 'user placeholder', model: 'placeholder-model' });
    expect(result.status).toBe('success');
    expect(result.result).toBe('placeholder reply');
    expect(result.model).toBe('placeholder-model');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0 });
  });

  it('rejects invalid request fields without invoking transport', async () => {
    const result = await connector.execute({
      prompt: 'user placeholder',
      model: 'placeholder-model',
      extra: { temperature: 2.5 },
    });
    expect(result.status).toBe('error');
    expect(result.error?.type).toBe('validation_error');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an empty text content block before transport', async () => {
    const result = await connector.execute({
      model: 'placeholder-model',
      prompt: [{ type: 'text', text: '   ' }],
    });
    expect(result.error?.type).toBe('validation_error');
    expect(request).not.toHaveBeenCalled();
  });

  it('classifies provider authentication errors without leaking authorization', async () => {
    request.mockResolvedValueOnce({ status: 401, body: providerError });
    const result = await connector.execute({ prompt: 'user placeholder', model: 'placeholder-model' });
    expect(result.error?.type).toBe('auth_error');
    expect(JSON.stringify(result)).not.toContain('placeholder-test-key');
    expect(result.error?.message).toContain('placeholder authentication failure');
  });

  it.each([
    [408, 'timeout'],
    [410, 'model_not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error'],
    [400, 'validation_error'],
  ])('maps HTTP %i to %s', async (status, errorType) => {
    request.mockResolvedValueOnce({ status, body: providerError });
    const result = await connector.execute({ prompt: 'user placeholder', model: 'placeholder-model' });
    expect(result.error?.type).toBe(errorType);
  });

  it('fails closed on malformed success payloads', async () => {
    request.mockResolvedValueOnce({ status: 200, body: { choices: [] } });
    const result = await connector.execute({ prompt: 'user placeholder', model: 'placeholder-model' });
    expect(result.error?.type).toBe('parse_error');
  });

  it('discovers models through the exact unpaginated allowlisted path', async () => {
    request.mockResolvedValueOnce({ status: 200, body: modelsSuccess });
    await connector.refreshModels();
    const sent = request.mock.calls[0][0] as SambaNovaTransportRequest;
    expect(sent).toMatchObject({ method: 'GET', path: '/models', timeoutMs: 12_000 });
    expect(sent.body).toBeUndefined();
    expect(connector.getCapabilities().models).toEqual(['placeholder-model']);
    expect(connector.getCapabilities().modelMeta).toEqual([
      {
        id: 'placeholder-model',
        modality: 'chat',
        contextWindow: 128,
        maxOutputTokens: 32,
      },
    ]);
  });

  it('atomically preserves the prior catalogue when discovery is malformed', async () => {
    request.mockResolvedValueOnce({ status: 200, body: modelsSuccess });
    await connector.refreshModels();
    request.mockResolvedValueOnce({ status: 200, body: { object: 'list', data: [{ id: '' }] } });
    await expect(connector.refreshModels()).rejects.toThrow('model list');
    expect(connector.getCapabilities().models).toEqual(['placeholder-model']);
  });

  it('advertises only the implemented offline-verifiable capability floor', () => {
    expect(connector.getCapabilities()).toMatchObject({
      name: 'sambanova-cloud',
      type: 'api',
      models: [],
      supportsStreaming: true,
      supportsJsonSchema: true,
      supportsTools: false,
      modality: 'chat',
    });
  });

  it('streams data-only SSE across transport chunk boundaries through the DONE sentinel', async () => {
    request.mockResolvedValueOnce({
      status: 200,
      body: chunked(streamSuccess, [17, 113, 251, streamSuccess.length - 8]),
    });

    const deltas: string[] = [];
    for await (const delta of connector.stream({
      model: 'placeholder-model',
      prompt: 'user placeholder',
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(['placeholder ', 'stream']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path: '/chat/completions',
      body: {
        model: 'placeholder-model',
        messages: [{ role: 'user', content: 'user placeholder' }],
        stream: true,
      },
    });
  });

  it('rejects an SSE stream that closes without the documented DONE sentinel', async () => {
    const withoutDone = streamSuccess.replace('data: [DONE]', '');
    request.mockResolvedValueOnce({ status: 200, body: chunked(withoutDone, [41, 199]) });

    const consume = async (): Promise<void> => {
      for await (const delta of connector.stream({
        model: 'placeholder-model',
        prompt: 'user placeholder',
      })) {
        void delta;
      }
    };

    await expect(consume()).rejects.toThrow('DONE');
  });

  it('forwards ordered OpenAI-format text and image_url content blocks unchanged', async () => {
    request.mockResolvedValueOnce({ status: 200, body: chatSuccess });
    const blocks = [
      { type: 'text' as const, text: 'Describe this image' },
      {
        type: 'image_url' as const,
        image_url: { url: 'data:image/jpeg;base64,cGxhY2Vob2xkZXI=', detail: 'high' as const },
      },
    ];

    const result = await connector.execute({ model: 'placeholder-model', prompt: blocks });

    expect(result.status).toBe('success');
    expect(request.mock.calls[0][0]).toMatchObject({
      body: {
        model: 'placeholder-model',
        messages: [{ role: 'user', content: blocks }],
        stream: false,
      },
    });
  });

  it('maps the shared JSON schema to SambaNova response_format exactly', async () => {
    request.mockResolvedValueOnce({ status: 200, body: chatSuccess });
    const jsonSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };

    await connector.execute({ model: 'placeholder-model', prompt: 'Return JSON', jsonSchema });

    expect(request.mock.calls[0][0]).toMatchObject({
      body: {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'connector_response',
            strict: true,
            schema: jsonSchema,
          },
        },
      },
    });
  });
});
