import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import modelsFixture from './__fixtures__/models-sample.json';
import { TogetherConnector } from './together.connector';

describe('TogetherConnector', () => {
  const originalKey = process.env.TOGETHER_API_KEY;

  beforeEach(() => {
    process.env.TOGETHER_API_KEY = 'fixture-key';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TOGETHER_API_KEY;
    else process.env.TOGETHER_API_KEY = originalKey;
  });

  it('preserves Together identity and conservative implemented capabilities', () => {
    const capabilities = new TogetherConnector().getCapabilities();
    expect(capabilities.name).toBe('together');
    expect(capabilities.type).toBe('api');
    expect(capabilities.supportsStreaming).toBe(false);
    expect(capabilities.supportsJsonSchema).toBe(false);
    expect(capabilities.supportsTools).toBe(false);
  });

  it('uses Together chat URL, Bearer auth, messages, and usage semantics', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'req-1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await new TogetherConnector().execute({
      prompt: 'hi', systemPrompt: 'be concise', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    });

    expect(response.status).toBe('success');
    expect(response.result).toBe('hello');
    expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.together.xyz/v1/chat/completions');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      messages: [{ role: 'system', content: 'be concise' }, { role: 'user', content: 'hi' }],
    });
  });

  it('discovers chat models from the documented complete plain array without pagination', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(modelsFixture), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const connector = new TogetherConnector();
    await connector.refreshModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.together.xyz/v1/models');
    expect(connector.getCapabilities().models).toEqual(['meta-llama/Llama-3.3-70B-Instruct-Turbo']);
  });

  it.each([[429, 'rate_limited', 'rate_limited'], [503, 'server_error', 'error']] as const)(
    'normalizes Together HTTP %s through the shared error contract', async (status, type, responseStatus) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'provider error' } }), { status }),
      );
      const response = await new TogetherConnector().execute({ prompt: 'hi', model: 'model' });
      expect(response.status).toBe(responseStatus);
      expect(response.error?.type).toBe(type);
    },
  );
});
