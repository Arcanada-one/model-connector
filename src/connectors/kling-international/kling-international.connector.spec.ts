import { describe, expect, it, vi } from 'vitest';
import {
  KLING_INTERNATIONAL_BASE_URL,
  KlingInternationalConnector,
  type KlingHttpTransport,
  type KlingJwtSigner,
} from './kling-international.connector';

describe('KlingInternationalConnector', () => {
  it('creates and queries each documented asynchronous video family', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { code: 0, message: 'ok', request_id: 'req-1', data: { task_id: 'task-1' } },
    });
    const transport: KlingHttpTransport = { request };
    const sign = vi.fn().mockReturnValue('deterministic-token');
    const signer: KlingJwtSigner = { sign };
    const connector = new KlingInternationalConnector(transport, signer, 'access-key', () => 1_700_000_000);

    await connector.createTextToVideo({ prompt: 'ocean' });
    await connector.queryTextToVideo('task-1');
    await connector.createImageToVideo({ image: 'https://example.test/input.png' });
    await connector.queryImageToVideo('task-2');
    await connector.createMultiImageToVideo({ image_list: ['https://example.test/a.png'] });
    await connector.queryMultiImageToVideo('task-3');

    expect(sign).toHaveBeenCalledWith(
      { iss: 'access-key', exp: 1_700_001_800, nbf: 1_699_999_995 },
      { alg: 'HS256', typ: 'JWT' },
    );
    expect(request.mock.calls.map(([call]) => [call.method, call.url])).toEqual([
      ['POST', `${KLING_INTERNATIONAL_BASE_URL}/v1/videos/text2video`],
      ['GET', `${KLING_INTERNATIONAL_BASE_URL}/v1/videos/text2video/task-1`],
      ['POST', `${KLING_INTERNATIONAL_BASE_URL}/v1/videos/image2video`],
      ['GET', `${KLING_INTERNATIONAL_BASE_URL}/v1/videos/image2video/task-2`],
      ['POST', `${KLING_INTERNATIONAL_BASE_URL}/v1/videos/multi-image2video`],
      ['GET', `${KLING_INTERNATIONAL_BASE_URL}/v1/videos/multi-image2video/task-3`],
    ]);
    for (const [call] of request.mock.calls) {
      expect(call.headers).toEqual({
        Authorization: 'Bearer deterministic-token',
        'Content-Type': 'application/json',
      });
    }
  });

  it('preserves provider-native success and error envelopes', async () => {
    const envelope = { code: 1004, message: 'expired', request_id: 'req-2', data: null };
    const transport: KlingHttpTransport = {
      request: vi.fn().mockResolvedValue({ status: 401, body: envelope }),
    };
    const connector = new KlingInternationalConnector(
      transport,
      { sign: () => 'token' },
      'access-key',
      () => 1,
    );

    await expect(connector.queryTextToVideo('task')).resolves.toEqual({ status: 401, ...envelope });
  });
});
