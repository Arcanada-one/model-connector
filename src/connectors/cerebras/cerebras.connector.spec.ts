import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CerebrasConnector } from './cerebras.connector';
import { CerebrasModule } from './cerebras.module';
import type { ConnectorsService } from '../connectors.service';

const chatFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../..', 'test/fixtures/connectors/cerebras-chat.json'),
    'utf8',
  ),
);
const modelsFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../..', 'test/fixtures/connectors/cerebras-models.json'),
    'utf8',
  ),
);

describe('CerebrasConnector', () => {
  let connector: CerebrasConnector;

  beforeEach(() => {
    process.env.CEREBRAS_API_KEY = 'fixture-key';
    connector = new CerebrasConnector();
    connector.setSemaphore(1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CEREBRAS_API_KEY;
  });

  it('uses distinct Cerebras identity and conservative capabilities', () => {
    expect(connector.name).toBe('cerebras');
    expect(connector.getCapabilities()).toMatchObject({
      name: 'cerebras',
      models: ['gpt-oss-120b', 'zai-glm-4.7'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
    });
  });

  it('registers distinctly without refreshing models on module init', () => {
    const register = vi.fn();
    const refresh = vi.spyOn(connector, 'refreshModels');
    const module = new CerebrasModule(connector, { register } as unknown as ConnectorsService);

    module.onModuleInit();

    expect(register).toHaveBeenCalledWith(connector);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('posts exact chat semantics with Bearer authentication and maps usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(chatFixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await connector.execute({ prompt: 'Hello', systemPrompt: 'Be concise' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cerebras.ai/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer fixture-key',
        },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: 'gpt-oss-120b',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(result).toMatchObject({
      connector: 'cerebras',
      model: 'gpt-oss-120b',
      result: 'Fixture response',
      usage: { inputTokens: 9, outputTokens: 12, totalTokens: 21, costUsd: 0 },
      status: 'success',
    });
  });

  it('replaces fallback models from one unpaginated authenticated models request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...modelsFixture, data: [{ id: 'future-model' }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await connector.refreshModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cerebras.ai/v1/models');
    expect(connector.getCapabilities().models).toEqual(['future-model']);
  });

  it.each([
    [401, 'auth_error', 'error'],
    [429, 'rate_limited', 'rate_limited'],
    [503, 'server_error', 'error'],
  ] as const)('maps HTTP %s to %s', async (status, errorType, responseStatus) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { message: `fixture ${status}` } }), { status }),
        ),
    );

    const result = await connector.execute({ prompt: 'offline fixture' });

    expect(result.status).toBe(responseStatus);
    expect(result.error?.type).toBe(errorType);
  });
});
