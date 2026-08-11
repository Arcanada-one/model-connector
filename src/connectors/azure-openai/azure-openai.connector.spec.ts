import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureOpenAiConnector } from './azure-openai.connector';

describe('AzureOpenAiConnector', () => {
  const completion = {
    model: 'gpt-4o-2024-08-06',
    choices: [{ message: { role: 'assistant', content: 'azure ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example-resource.openai.azure.com/';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'chat deployment/blue';
    process.env.AZURE_OPENAI_API_KEY = 'fixture-key-not-a-secret';
    delete process.env.AZURE_OPENAI_API_VERSION;
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => completion });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env))
      if (key.startsWith('AZURE_OPENAI_')) delete process.env[key];
  });

  it('uses the encoded deployment-scoped dated data-plane URL', async () => {
    await new AzureOpenAiConnector().execute({ prompt: 'hello' });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://example-resource.openai.azure.com/openai/deployments/chat%20deployment%2Fblue/chat/completions?api-version=2024-10-21',
    );
  });

  it('uses only api-key for key authentication', async () => {
    await new AzureOpenAiConnector().execute({ prompt: 'hello' });
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      'api-key': 'fixture-key-not-a-secret',
    });
  });

  it('calls an injected Entra provider per request and never sends api-key', async () => {
    delete process.env.AZURE_OPENAI_API_KEY;
    const provider = vi.fn().mockResolvedValueOnce('token-one').mockResolvedValueOnce('token-two');
    const connector = new AzureOpenAiConnector({
      tokenProvider: provider,
      headers: { 'X-Trace-Mode': 'fixture' },
    });
    await connector.execute({ prompt: 'one' });
    await connector.execute({ prompt: 'two' });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      'X-Trace-Mode': 'fixture',
      Authorization: 'Bearer token-one',
    });
    expect(fetchSpy.mock.calls[1][1].headers.Authorization).toBe('Bearer token-two');
    expect(fetchSpy.mock.calls[1][1].headers['api-key']).toBeUndefined();
  });

  it('rejects ambiguous dual authentication before invoking the provider or fetch', async () => {
    const provider = vi.fn().mockResolvedValue('token');
    const response = await new AzureOpenAiConnector({
      apiKey: 'injected-key',
      tokenProvider: provider,
    }).execute({ prompt: 'hello' });
    expect(response.error?.message).toContain('mutually exclusive');
    expect(provider).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('supports fully injected URL, key, version, deployment, and custom headers', async () => {
    for (const key of Object.keys(process.env))
      if (key.startsWith('AZURE_OPENAI_')) delete process.env[key];
    const connector = new AzureOpenAiConnector({
      endpoint: 'https://injected.openai.azure.com/',
      deployment: 'prod/chat blue',
      apiVersion: '2025-01-01',
      apiKey: 'injected-key',
      headers: { 'X-Client': 'model-connector' },
    });
    await connector.execute({ prompt: 'hello' });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://injected.openai.azure.com/openai/deployments/prod%2Fchat%20blue/chat/completions?api-version=2025-01-01',
    );
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      'X-Client': 'model-connector',
      'api-key': 'injected-key',
    });
    expect(connector.getCapabilities().models).toEqual(['prod/chat blue']);
  });

  it('maps response content and usage', async () => {
    const response = await new AzureOpenAiConnector().execute({ prompt: 'hello' });
    expect(response).toMatchObject({
      status: 'success',
      result: 'azure ok',
      model: completion.model,
    });
    expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it('maps the Azure error envelope without exposing unrelated JSON', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({
          error: { code: 'TooManyRequests', message: 'Retry later' },
          trace: 'omit-me',
        }),
    });
    const response = await new AzureOpenAiConnector().execute({ prompt: 'hello' });
    expect(response.status).toBe('rate_limited');
    expect(response.error?.message).toBe('TooManyRequests: Retry later');
    expect(response.error?.message).not.toContain('omit-me');
  });

  it.each([
    [401, 'invalid_api_key', 'auth_error'],
    [404, 'DeploymentNotFound', 'http_error'],
    [500, 'InternalServerError', 'server_error'],
  ])('maps Azure HTTP %i %s without leaking the key', async (status, code, type) => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => JSON.stringify({ error: { code, message: 'provider failure' } }),
    });
    const response = await new AzureOpenAiConnector().execute({ prompt: 'hello' });
    expect(response.error).toMatchObject({ type, message: `${code}: provider failure` });
    expect(response.error?.message).not.toContain('fixture-key-not-a-secret');
  });

  it('reports exactly the configured deployment and no streaming support', () => {
    expect(new AzureOpenAiConnector().getCapabilities()).toMatchObject({
      name: 'azure-openai',
      models: ['chat deployment/blue'],
      supportsStreaming: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires an authentication source before fetch', async () => {
    delete process.env.AZURE_OPENAI_API_KEY;
    const response = await new AzureOpenAiConnector().execute({ prompt: 'hello' });
    expect(response.status).toBe('error');
    expect(response.error?.message).toContain('authentication');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
