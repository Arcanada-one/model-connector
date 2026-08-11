import { describe, expect, it, vi } from 'vitest';

import {
  BFL_BASE_URLS,
  BFL_FLUX_OPERATIONS,
  BlackForestLabsConnector,
  type BflTransport,
  type BflTransportRequest,
} from './black-forest-labs.connector';

const endpointCases = [
  ['flux2Flex', '/flux-2-flex'],
  ['flux2Klein4b', '/flux-2-klein-4b'],
  ['flux2Klein9b', '/flux-2-klein-9b'],
  ['flux2Klein9bPreview', '/flux-2-klein-9b-preview'],
  ['flux2Max', '/flux-2-max'],
  ['flux2Pro', '/flux-2-pro'],
  ['flux2ProPreview', '/flux-2-pro-preview'],
  ['fluxDev', '/flux-dev'],
  ['fluxPro', '/flux-pro'],
  ['fluxPro11', '/flux-pro-1.1'],
  ['fluxPro11Ultra', '/flux-pro-1.1-ultra'],
  ['kontextMax', '/flux-kontext-max'],
  ['kontextPro', '/flux-kontext-pro'],
  ['fill', '/flux-pro-1.0-fill'],
  ['expand', '/flux-pro-1.0-expand'],
] as const;

function connectorWith(
  result: unknown,
  baseUrl: (typeof BFL_BASE_URLS)[keyof typeof BFL_BASE_URLS] = BFL_BASE_URLS.global,
) {
  const request = vi.fn<(request: BflTransportRequest) => Promise<unknown>>();
  request.mockResolvedValue(result);
  const transport: BflTransport = { request };
  return {
    connector: new BlackForestLabsConnector('test-bfl-key', transport, baseUrl),
    request,
  };
}

describe('BlackForestLabsConnector', () => {
  it('declares exactly the documented AU-014 endpoints', () => {
    expect(Object.entries(BFL_FLUX_OPERATIONS)).toEqual(endpointCases);
  });

  it.each(endpointCases)('maps %s to the exact global first-party path', async (method, path) => {
    const nativeBody = {
      prompt: 'A paper boat',
      input_image: 'base64-reference',
      untouched_extension: { preserve: true },
    };
    const nativeStarted = {
      id: 'request-id',
      polling_url: 'https://api.bfl.ai/v1/get_result?id=request-id',
      cost: 4,
      input_mp: 1,
      output_mp: 1,
    };
    const { connector, request } = connectorWith(nativeStarted);

    await expect(connector[method](nativeBody)).resolves.toBe(nativeStarted);
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: `${BFL_BASE_URLS.global}${path}`,
      headers: {
        'Content-Type': 'application/json',
        'x-key': 'test-bfl-key',
      },
      body: nativeBody,
    });
  });

  it.each(Object.values(BFL_BASE_URLS))(
    'uses the closed documented request base %s',
    async (baseUrl) => {
      const { connector, request } = connectorWith({ id: 'request-id' }, baseUrl);

      await connector.flux2Pro({ prompt: 'regional request' });

      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: `${baseUrl}/flux-2-pro`,
        }),
      );
    },
  );

  it('gets the result from the exact returned polling URL without interpreting native status', async () => {
    const nativeResult = {
      id: 'request-id',
      status: 'Content Moderated',
      result: null,
      progress: null,
      details: { reason: 'provider-owned' },
      preview: {},
    };
    const pollingUrl = 'https://api.eu.bfl.ai/v1/get_result?id=request-id';
    const { connector, request } = connectorWith(nativeResult, BFL_BASE_URLS.eu);

    await expect(connector.getResult(pollingUrl)).resolves.toBe(nativeResult);
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: pollingUrl,
      headers: { 'x-key': 'test-bfl-key' },
    });
  });

  it('preserves a provider-native create transport error by identity', async () => {
    const providerError = {
      status: 422,
      body: { detail: [{ type: 'missing', loc: ['body', 'prompt'], msg: 'Field required' }] },
    };
    const request = vi.fn().mockRejectedValue(providerError);
    const connector = new BlackForestLabsConnector('test-bfl-key', { request });

    await expect(connector.flux2Pro({})).rejects.toBe(providerError);
  });

  it('preserves a provider-native result transport error by identity', async () => {
    const providerError = { status: 429, body: { detail: 'Rate limit exceeded' } };
    const request = vi.fn().mockRejectedValue(providerError);
    const connector = new BlackForestLabsConnector('test-bfl-key', { request });

    await expect(
      connector.getResult('https://api.us.bfl.ai/v1/get_result?id=request-id'),
    ).rejects.toBe(providerError);
  });

  it('rejects an absent API key before invoking transport', async () => {
    const request = vi.fn();
    const connector = new BlackForestLabsConnector('', { request });

    await expect(connector.fluxDev({ prompt: 'must not send' })).rejects.toThrow(
      'Black Forest Labs API key is required',
    );
    await expect(
      connector.getResult('https://api.bfl.ai/v1/get_result?id=request-id'),
    ).rejects.toThrow('Black Forest Labs API key is required');
    expect(request).not.toHaveBeenCalled();
  });
});
