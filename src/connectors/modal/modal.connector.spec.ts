import { describe, expect, it, vi } from 'vitest';
import { ModalConnector, type ModalTransport } from './modal.connector';

const config = {
  endpointUrl: 'https://deployment.example',
  model: 'org/deployed-model',
  authMode: 'proxy' as const,
  proxyKey: 'wk-example',
  proxySecret: 'ws-example',
  timeoutMs: 12_000,
};

describe('ModalConnector', () => {
  it('invokes the fixed OpenAI-compatible deployed endpoint with proxy headers', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        id: 'chatcmpl-1',
        model: 'org/deployed-model',
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    });
    const connector = new ModalConnector(config, { request } as ModalTransport);
    const result = await connector.execute({ prompt: 'hi' });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://deployment.example/v1/chat/completions',
        method: 'POST',
        headers: expect.objectContaining({
          'Modal-Key': 'wk-example',
          'Modal-Secret': 'ws-example',
        }),
      }),
    );
    expect(result.status).toBe('success');
    expect(result.result).toBe('hello');
  });

  it('rejects streaming before transport', async () => {
    const request = vi.fn();
    const connector = new ModalConnector(config, { request } as ModalTransport);
    const result = await connector.execute({ prompt: 'hi', extra: { stream: true } });
    expect(result.error?.type).toBe('validation_error');
    expect(request).not.toHaveBeenCalled();
  });

  it('discovers only models returned by the deployed endpoint', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ data: [{ id: 'org/live-model' }] }),
    });
    const connector = new ModalConnector(config, { request } as ModalTransport);
    await connector.refreshModels();
    expect(connector.getCapabilities().models).toEqual(['org/live-model']);
  });

  it('preserves upstream auth errors without leaking credentials', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 401,
      body: 'modal-http: missing credentials for proxy authorization',
    });
    const connector = new ModalConnector(config, { request } as ModalTransport);
    const result = await connector.execute({ prompt: 'hi' });
    expect(result.error?.type).toBe('auth_error');
    expect(result.error?.message).not.toContain('wk-example');
    expect(result.error?.message).not.toContain('ws-example');
  });
});
