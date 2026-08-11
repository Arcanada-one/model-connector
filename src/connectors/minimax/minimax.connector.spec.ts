import { describe, expect, it, vi } from 'vitest';

import {
  MINIMAX_INTERNATIONAL_BASE_URL,
  MINIMAX_VIDEO_TASK_STATUSES,
  MinimaxConnector,
  MinimaxApiError,
  type MinimaxTransport,
} from './minimax.connector';

describe('MinimaxConnector', () => {
  it('uses the international MiniMax host through an injected transport', async () => {
    const transport: MinimaxTransport = {
      request: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    };
    const connector = new MinimaxConnector('test-api-key', transport);

    await connector.createVideo({
      model: 'MiniMax-Hailuo-2.3',
      prompt: 'A lighthouse in fog.',
    });

    expect(transport.request).toHaveBeenCalledWith({
      method: 'POST',
      url: `${MINIMAX_INTERNATIONAL_BASE_URL}/video_generation`,
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
      },
      body: {
        model: 'MiniMax-Hailuo-2.3',
        prompt: 'A lighthouse in fog.',
      },
    });
  });
});

describe('MiniMax documented asynchronous lifecycle', () => {
  const success = { status_code: 0, status_msg: 'success' };

  it('exposes only the five statuses documented for video-generation queries', () => {
    expect(MINIMAX_VIDEO_TASK_STATUSES).toEqual([
      'Preparing',
      'Queueing',
      'Processing',
      'Success',
      'Fail',
    ]);
  });

  it('passes all four documented request families without reshaping provider fields', async () => {
    const request = vi.fn().mockResolvedValue({ task_id: 'task-1', base_resp: success });
    const connector = new MinimaxConnector('key', { request });
    const families = [
      { model: 'MiniMax-Hailuo-2.3', prompt: 'text' },
      { model: 'MiniMax-Hailuo-2.3', first_frame_image: 'https://example.test/a.png' },
      {
        model: 'MiniMax-Hailuo-02',
        first_frame_image: 'https://example.test/a.png',
        last_frame_image: 'https://example.test/b.png',
      },
      {
        model: 'S2V-01',
        subject_reference: [{ type: 'character' as const, image: ['data:image/png;base64,AA=='] }],
      },
    ];

    for (const family of families) await connector.createVideo(family);

    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.map(([call]) => call.body)).toEqual(families);
  });

  it('queries one task by task_id with the exact documented status vocabulary', async () => {
    const request = vi.fn().mockResolvedValue({
      task_id: 'task-1',
      status: 'Queueing',
      base_resp: success,
    });
    const connector = new MinimaxConnector('key', { request });

    await expect(connector.queryVideo('task-1')).resolves.toMatchObject({ status: 'Queueing' });
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: `${MINIMAX_INTERNATIONAL_BASE_URL}/query/video_generation`,
      headers: { Authorization: 'Bearer key' },
      query: { task_id: 'task-1' },
    });
  });

  it('retrieves generated file metadata by file_id', async () => {
    const response = {
      file: {
        file_id: 'file-1',
        bytes: 42,
        created_at: 1,
        filename: 'output.mp4',
        purpose: 'video_generation',
        download_url: 'https://download.example.test/output.mp4',
      },
      base_resp: success,
    };
    const request = vi.fn().mockResolvedValue(response);
    const connector = new MinimaxConnector('key', { request });

    await expect(connector.retrieveFile('file-1')).resolves.toEqual(response);
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: `${MINIMAX_INTERNATIONAL_BASE_URL}/files/retrieve`,
      headers: { Authorization: 'Bearer key' },
      query: { file_id: 'file-1' },
    });
  });

  it('preserves documented provider error code and message', async () => {
    const connector = new MinimaxConnector('key', {
      request: vi.fn().mockResolvedValue({
        task_id: '',
        base_resp: { status_code: 1004, status_msg: 'invalid request' },
      }),
    });

    await expect(connector.createVideo({ model: 'MiniMax-Hailuo-2.3' })).rejects.toEqual(
      new MinimaxApiError(1004, 'invalid request'),
    );
  });

  it('rejects an absent credential before transport invocation', () => {
    expect(() => new MinimaxConnector('', { request: vi.fn() })).toThrow(
      'MiniMax international API key is required',
    );
  });
});
