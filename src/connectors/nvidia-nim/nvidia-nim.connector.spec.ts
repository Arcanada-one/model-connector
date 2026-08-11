import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NvidiaNimConfigurationError,
  NvidiaNimConnector,
  type NvidiaNimTransport,
  type NvidiaNimTransportRequest,
  type NvidiaNimTransportResponse,
} from './nvidia-nim.connector';

const fixtures = join(__dirname, 'fixtures');
const successFixture = JSON.parse(
  readFileSync(join(fixtures, 'chat-success.json'), 'utf8'),
) as unknown;
const errorFixture = JSON.parse(readFileSync(join(fixtures, 'chat-error.json'), 'utf8')) as unknown;
const streamFixture = readFileSync(join(fixtures, 'chat-stream.sse'), 'utf8');

class RecordingTransport implements NvidiaNimTransport {
  readonly requests: NvidiaNimTransportRequest[] = [];

  constructor(private readonly responses: NvidiaNimTransportResponse[]) {}

  async send(request: NvidiaNimTransportRequest): Promise<NvidiaNimTransportResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('fixture transport exhausted');
    return response;
  }
}

const baseConfig = {
  baseUrl: 'http://127.0.0.1:18000/nim/',
  model: 'fixture/model-1',
  auth: { type: 'none' as const },
  timeoutMs: 12_000,
};

describe('NvidiaNimConnector', () => {
  it('requires an injected transport and validates the self-hosted configuration boundary', () => {
    expect(() => Reflect.construct(NvidiaNimConnector, [baseConfig])).toThrow(
      NvidiaNimConfigurationError,
    );

    const transport = new RecordingTransport([]);
    for (const baseUrl of [
      'ftp://fixture.invalid/nim',
      'http://user:password@fixture.invalid',
      'http://fixture.invalid/nim?token=fixture',
      'http://fixture.invalid/nim#fragment',
    ]) {
      expect(() => new NvidiaNimConnector({ ...baseConfig, baseUrl }, transport)).toThrow(
        NvidiaNimConfigurationError,
      );
    }
    expect(
      () => new NvidiaNimConnector({ ...baseConfig, model: 'fixture\nmodel' }, transport),
    ).toThrow(NvidiaNimConfigurationError);
    expect(
      () =>
        new NvidiaNimConnector(
          {
            ...baseConfig,
            auth: { type: 'header', name: 'Authorization', value: 'fixture-value' },
          },
          transport,
        ),
    ).toThrow(NvidiaNimConfigurationError);
  });

  it('builds the documented chat request and maps the OpenAI-compatible response', async () => {
    const transport = new RecordingTransport([{ status: 200, body: successFixture }]);
    const connector = new NvidiaNimConnector(baseConfig, transport);

    const response = await connector.execute({
      prompt: 'fixture prompt',
      systemPrompt: 'fixture system',
      extra: { max_tokens: 64, temperature: 0.25, top_p: 0.9 },
    });

    expect(transport.requests).toEqual([
      {
        method: 'POST',
        url: 'http://127.0.0.1:18000/nim/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: 'fixture/model-1',
          messages: [
            { role: 'system', content: 'fixture system' },
            { role: 'user', content: 'fixture prompt' },
          ],
          max_tokens: 64,
          temperature: 0.25,
          top_p: 0.9,
        },
        timeoutMs: 12_000,
        stream: false,
      },
    ]);
    expect(response).toMatchObject({
      id: 'chatcmpl-fixture-001',
      connector: 'nvidia-nim',
      model: 'fixture/model-1',
      result: 'fixture response',
      status: 'success',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0 },
    });
  });

  it('keeps runtime auth explicit and never leaks configured auth in errors', async () => {
    const bearerTransport = new RecordingTransport([{ status: 401, body: errorFixture }]);
    const bearer = new NvidiaNimConnector(
      {
        ...baseConfig,
        auth: { type: 'bearer', token: 'fixture-deployment-token' },
      },
      bearerTransport,
    );
    const bearerResponse = await bearer.execute({ prompt: 'fixture prompt' });

    expect(bearerTransport.requests[0]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer fixture-deployment-token',
    });
    expect(bearerResponse.error).toMatchObject({
      type: 'auth_error',
      retryable: false,
      recommendation: 'reauth',
    });
    expect(bearerResponse.error?.message).not.toContain('fixture-deployment-token');

    const headerTransport = new RecordingTransport([{ status: 429, body: 'fixture limited' }]);
    const header = new NvidiaNimConnector(
      {
        ...baseConfig,
        auth: { type: 'header', name: 'X-Deployment-Key', value: 'fixture-header-value' },
      },
      headerTransport,
    );
    const headerResponse = await header.execute({ prompt: 'fixture prompt' });
    expect(headerTransport.requests[0]?.headers['X-Deployment-Key']).toBe('fixture-header-value');
    expect(headerResponse).toMatchObject({ status: 'rate_limited', error: { type: 'rate_limited' } });
  });

  it.each([
    [404, { error: { message: 'The model does not exist', code: 'model_not_found' } }, 'model_not_found'],
    [503, { error: { message: 'fixture unavailable' } }, 'server_error'],
    [418, 'fixture response', 'http_error'],
  ])('maps HTTP %s conservatively to %s', async (status, body, expectedType) => {
    const transport = new RecordingTransport([{ status, body }]);
    const connector = new NvidiaNimConnector(baseConfig, transport);
    const response = await connector.execute({ prompt: 'fixture prompt' });
    expect(response.error?.type).toBe(expectedType);
  });

  it('parses documented SSE chat deltas in order and stops at DONE', async () => {
    const transport = new RecordingTransport([{ status: 200, body: streamFixture }]);
    const connector = new NvidiaNimConnector(baseConfig, transport);

    const chunks: string[] = [];
    for await (const chunk of connector.stream({ prompt: 'fixture prompt' })) chunks.push(chunk);

    expect(chunks).toEqual(['fixture ', 'stream']);
    expect(transport.requests[0]).toMatchObject({
      method: 'POST',
      url: 'http://127.0.0.1:18000/nim/v1/chat/completions',
      body: { model: 'fixture/model-1', stream: true },
      stream: true,
    });
  });

  it('limits readiness, model selection, and capabilities to the configured runtime', async () => {
    const transport = new RecordingTransport([{ status: 200, body: '' }]);
    const connector = new NvidiaNimConnector(baseConfig, transport);

    expect(await connector.getStatus()).toMatchObject({ name: 'nvidia-nim', healthy: true });
    expect(transport.requests[0]).toEqual({
      method: 'GET',
      url: 'http://127.0.0.1:18000/nim/v1/health/ready',
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 12_000,
      stream: false,
    });
    expect(connector.getCapabilities()).toEqual({
      name: 'nvidia-nim',
      type: 'api',
      models: ['fixture/model-1'],
      modelMeta: [{ id: 'fixture/model-1', modality: 'chat' }],
      modality: 'chat',
      supportsStreaming: true,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 12_000,
    });

    const response = await connector.execute({
      prompt: 'fixture prompt',
      model: 'fixture/other-model',
    });
    expect(response).toMatchObject({ status: 'error', error: { type: 'model_not_found' } });
    expect(transport.requests).toHaveLength(1);
    expect(connector.resetCircuitBreaker()).toEqual([]);
  });
});
