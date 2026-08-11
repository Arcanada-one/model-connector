import { describe, expect, it, vi } from 'vitest';

import {
  STABILITY_AI_BASE_URL,
  STABILITY_AI_IMAGE_OPERATIONS,
  StabilityAiConnector,
  type StabilityAiTransport,
  type StabilityAiTransportRequest,
} from './stability-ai.connector';

const endpointCases = [
  ['generateCore', '/v2beta/stable-image/generate/core'],
  ['generateUltra', '/v2beta/stable-image/generate/ultra'],
  ['generateSd3', '/v2beta/stable-image/generate/sd3'],
  ['editInpaint', '/v2beta/stable-image/edit/inpaint'],
  ['editOutpaint', '/v2beta/stable-image/edit/outpaint'],
  ['editErase', '/v2beta/stable-image/edit/erase'],
  ['editSearchAndReplace', '/v2beta/stable-image/edit/search-and-replace'],
  ['editSearchAndRecolor', '/v2beta/stable-image/edit/search-and-recolor'],
  ['editRemoveBackground', '/v2beta/stable-image/edit/remove-background'],
  ['editReplaceBackgroundAndRelight', '/v2beta/stable-image/edit/replace-background-and-relight'],
] as const;

function connectorWith(result: unknown) {
  const request = vi.fn<(request: StabilityAiTransportRequest) => Promise<unknown>>();
  request.mockResolvedValue(result);
  const transport: StabilityAiTransport = { request };
  return { connector: new StabilityAiConnector('test-token', transport), request };
}

describe('StabilityAiConnector', () => {
  it.each(endpointCases)('maps %s to the exact first-party path', async (method, path) => {
    const nativeResult = { image: 'base64-data', finish_reason: 'SUCCESS', seed: 7 };
    const { connector, request } = connectorWith(nativeResult);
    const form = new FormData();
    form.append('prompt', 'A paper boat');

    await expect(connector[method](form, 'application/json')).resolves.toBe(nativeResult);
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: `${STABILITY_AI_BASE_URL}${path}`,
      headers: { Authorization: 'Bearer test-token', Accept: 'application/json' },
      body: form,
    });
  });

  it('declares exactly the three generation and seven edit operations', () => {
    expect(Object.entries(STABILITY_AI_IMAGE_OPERATIONS)).toEqual(endpointCases);
  });

  it('forwards image Accept and binary fields without setting multipart Content-Type', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const { connector, request } = connectorWith(bytes);
    const form = new FormData();
    const image = new Blob([bytes], { type: 'image/png' });
    form.append('image', image, 'source.png');
    form.append('prompt', 'Keep this exact field');

    await expect(connector.editInpaint(form, 'image/*')).resolves.toBe(bytes);
    const sent = request.mock.calls[0]?.[0];
    expect(sent?.body).toBe(form);
    expect(sent?.headers).toEqual({ Authorization: 'Bearer test-token', Accept: 'image/*' });
    expect(sent?.headers).not.toHaveProperty('Content-Type');
    expect([...form.keys()]).toEqual(['image', 'prompt']);
  });

  it('preserves the asynchronous relight id response without polling or reshaping', async () => {
    const started = { id: 'generation-id-from-provider' };
    const { connector, request } = connectorWith(started);

    await expect(
      connector.editReplaceBackgroundAndRelight(new FormData(), 'application/json'),
    ).resolves.toBe(started);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves a provider-native transport error by identity', async () => {
    const providerError = { status: 422, body: { id: 'request-id', errors: ['invalid image'] } };
    const request = vi.fn().mockRejectedValue(providerError);
    const connector = new StabilityAiConnector('test-token', { request });

    await expect(connector.generateCore(new FormData(), 'application/json')).rejects.toBe(
      providerError,
    );
  });

  it('rejects an absent bearer token before invoking transport', async () => {
    const request = vi.fn();
    const connector = new StabilityAiConnector('', { request });

    await expect(connector.generateCore(new FormData(), 'image/*')).rejects.toThrow(
      'Stability AI bearer token is required',
    );
    expect(request).not.toHaveBeenCalled();
  });
});
