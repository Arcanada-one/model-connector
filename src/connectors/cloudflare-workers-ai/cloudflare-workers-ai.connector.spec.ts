import { describe, expect, it, vi, afterEach } from 'vitest';
import { CloudflareWorkersAiConnector } from './cloudflare-workers-ai.connector';

describe('CloudflareWorkersAiConnector native REST contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the account-scoped native run endpoint and Bearer auth', async () => {
    process.env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID = 'account-123';
    process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = 'fixture-token';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        errors: [],
        messages: [],
        result: { response: 'hello', usage: { prompt_tokens: 4, completion_tokens: 2 } },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await new CloudflareWorkersAiConnector().execute({
      prompt: 'hello',
      model: '@cf/meta/llama-3.1-8b-instruct',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-123/ai/run/@cf/meta/llama-3.1-8b-instruct',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
      }),
    );
    expect(response.result).toBe('hello');
    expect(response.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  });

  it('sends native messages and response_format fields without OpenAI choices', async () => {
    process.env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID = 'account-123';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { response: '{"ok":true}' }, success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await new CloudflareWorkersAiConnector().execute({
      prompt: 'return json',
      systemPrompt: 'Be concise',
      responseFormat: { type: 'json_object' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'return json' },
    ]);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body).not.toHaveProperty('model');
  });

  it('preserves Cloudflare v4 error code and message', async () => {
    process.env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID = 'account-123';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          result: null,
          errors: [{ code: 3036, message: 'daily neuron allocation exhausted' }],
          messages: [],
        }),
      }),
    );

    const response = await new CloudflareWorkersAiConnector().execute({ prompt: 'hello' });
    expect(response.status).toBe('error');
    expect(response.error?.message).toContain('3036');
    expect(response.error?.message).toContain('daily neuron allocation exhausted');
  });

  it('advertises only truthful native text-generation capabilities', () => {
    const capabilities = new CloudflareWorkersAiConnector().getCapabilities();
    expect(capabilities.name).toBe('cloudflare-workers-ai');
    expect(capabilities.supportsStreaming).toBe(false);
    expect(capabilities.supportsTools).toBe(false);
    expect(capabilities.supportsJsonSchema).toBe(true);
    expect(capabilities.models).toContain('@cf/meta/llama-3.1-8b-instruct');
  });
});
