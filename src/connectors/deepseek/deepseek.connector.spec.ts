import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekConnector } from './deepseek.connector';

const chatFixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/chat-success.json'), 'utf8'),
);
const modelsFixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/models.json'), 'utf8'),
);

describe('DeepSeekConnector', () => {
  let connector: DeepSeekConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'deepseek_test_sentinel';
    delete process.env.DEEPSEEK_BASE_URL;
    connector = new DeepSeekConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
  });

  function mockJson(body: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  it('uses the exact default base, Bearer auth, and /chat/completions', async () => {
    mockJson(chatFixture);
    await connector.execute({ prompt: 'hello' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer deepseek_test_sentinel');
  });

  it('preserves a configured /v1 compatibility base', async () => {
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
    connector = new DeepSeekConnector();
    mockJson(chatFixture);
    await connector.execute({ prompt: 'hello' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('returns reasoning_content and exact cache token counts in structured output', async () => {
    mockJson(chatFixture);
    const response = await connector.execute({ prompt: 'hello', model: 'deepseek-reasoner' });
    expect(response.result).toBe('Synthetic final answer.');
    expect(response.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(response.structured).toEqual({
      reasoning_content: 'Synthetic reasoning fixture.',
      usage: { prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 5 },
    });
  });

  it('omits unsupported sampling and logprob parameters for deepseek-reasoner', async () => {
    mockJson(chatFixture);
    await connector.execute({
      prompt: 'hello',
      model: 'deepseek-reasoner',
      extra: {
        temperature: 0.2,
        top_p: 0.8,
        presence_penalty: 1,
        frequency_penalty: 1,
        logprobs: true,
        top_logprobs: 2,
        max_tokens: 100,
      },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('presence_penalty');
    expect(body).not.toHaveProperty('frequency_penalty');
    expect(body).not.toHaveProperty('logprobs');
    expect(body).not.toHaveProperty('top_logprobs');
    expect(body.max_tokens).toBe(100);
  });

  it('refreshes /models with Bearer auth and preserves /v1 compatibility', async () => {
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
    connector = new DeepSeekConnector();
    mockJson(modelsFixture);
    await connector.refreshModels();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/models');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer deepseek_test_sentinel');
    expect(connector.getCapabilities().models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it.each([
    [400, 'validation_error', 'error'],
    [401, 'auth_error', 'error'],
    [402, 'billing_error', 'error'],
    [422, 'validation_error', 'error'],
    [429, 'rate_limited', 'rate_limited'],
    [500, 'server_error', 'error'],
    [503, 'server_error', 'error'],
  ])('maps DeepSeek HTTP %i to %s without invented retry delay', async (status, type, state) => {
    mockJson({ error: { message: `synthetic ${status}` } }, status);
    const response = await connector.execute({ prompt: 'hello' });
    expect(response.status).toBe(state);
    expect(response.error).toMatchObject({ type });
    expect(response.error?.retryAfter).toBeUndefined();
  });

  it('advertises only capabilities implemented by this connector', () => {
    expect(connector.getCapabilities()).toMatchObject({
      name: 'deepseek',
      type: 'api',
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
    });
  });
});
