import { describe, expect, it, vi } from 'vitest';
import {
  RUNWAY_API_ORIGIN,
  RUNWAY_API_VERSION,
  RUNWAY_OPERATION_ROUTES,
  RunwayConnector,
  type RunwayHttpRequest,
  type RunwayHttpResponse,
  type RunwayHttpTransport,
  type RunwayOperation,
  type RunwayTask,
} from './runway.connector';

class FakeTransport implements RunwayHttpTransport {
  readonly requests: RunwayHttpRequest[] = [];
  private readonly responses: RunwayHttpResponse[];

  constructor(...responses: RunwayHttpResponse[]) {
    this.responses = [...responses];
  }

  async request<T>(request: RunwayHttpRequest): Promise<RunwayHttpResponse<T>> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('Unexpected transport request');
    return response as RunwayHttpResponse<T>;
  }
}

const operations: RunwayOperation[] = [
  'image_to_video',
  'text_to_video',
  'video_to_video',
  'text_to_image',
  'image_upscale',
  'video_upscale',
  'character_performance',
  'sound_effect',
  'speech_to_speech',
  'text_to_speech',
  'voice_dubbing',
  'voice_isolation',
];

describe('RunwayConnector', () => {
  it.each(operations)('creates a native %s task without changing its body', async (operation) => {
    const transport = new FakeTransport({ status: 200, data: { id: `${operation}-id` } });
    const connector = new RunwayConnector(transport, 'test-key');
    const body = { model: 'provider-native-model', nested: { keep: true } };

    await expect(connector.generate(operation, body)).resolves.toEqual({ id: `${operation}-id` });
    expect(transport.requests).toEqual([
      {
        method: 'POST',
        url: `${RUNWAY_API_ORIGIN}${RUNWAY_OPERATION_ROUTES[operation]}`,
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
          'X-Runway-Version': RUNWAY_API_VERSION,
        },
        body,
      },
    ]);
    expect(transport.requests[0]?.body).toBe(body);
  });

  it('offers named methods for the three primary video modes', async () => {
    const transport = new FakeTransport(
      { status: 200, data: { id: 'i2v' } },
      { status: 200, data: { id: 't2v' } },
      { status: 200, data: { id: 'v2v' } },
    );
    const connector = new RunwayConnector(transport, 'test-key');

    await expect(connector.imageToVideo({ model: 'gen4.5' })).resolves.toEqual({ id: 'i2v' });
    await expect(connector.textToVideo({ model: 'gen4.5' })).resolves.toEqual({ id: 't2v' });
    await expect(connector.videoToVideo({ model: 'aleph2' })).resolves.toEqual({ id: 'v2v' });
  });

  it.each([
    ['PENDING', { id: 'task-id', status: 'PENDING', createdAt: '2026-07-11T00:00:00Z' }],
    ['THROTTLED', { id: 'task-id', status: 'THROTTLED', createdAt: '2026-07-11T00:00:00Z' }],
    [
      'RUNNING',
      { id: 'task-id', status: 'RUNNING', createdAt: '2026-07-11T00:00:00Z', progress: 0.5 },
    ],
    [
      'SUCCEEDED',
      {
        id: 'task-id',
        status: 'SUCCEEDED',
        createdAt: '2026-07-11T00:00:00Z',
        output: ['https://output.invalid/video.mp4'],
      },
    ],
    [
      'FAILED',
      {
        id: 'task-id',
        status: 'FAILED',
        createdAt: '2026-07-11T00:00:00Z',
        failure: 'rejected',
        failureCode: 'SAFETY.INPUT.TEXT',
      },
    ],
    ['CANCELLED', { id: 'task-id', status: 'CANCELLED', createdAt: '2026-07-11T00:00:00Z' }],
  ] as const)('returns the native %s task variant', async (_status, task) => {
    const transport = new FakeTransport({ status: 200, data: task });
    const connector = new RunwayConnector(transport, 'test-key');

    await expect(connector.getTask('task-id')).resolves.toEqual(task satisfies RunwayTask);
    expect(transport.requests[0]).toMatchObject({
      method: 'GET',
      url: `${RUNWAY_API_ORIGIN}/v1/tasks/task-id`,
    });
  });

  it('uses DELETE on the task resource as the only cancel/delete operation', async () => {
    const transport = new FakeTransport({ status: 204 });
    const connector = new RunwayConnector(transport, 'test-key');

    await expect(connector.deleteTask('task-id')).resolves.toBeUndefined();
    expect(transport.requests[0]).toMatchObject({
      method: 'DELETE',
      url: `${RUNWAY_API_ORIGIN}/v1/tasks/task-id`,
    });
  });

  it('creates an ephemeral upload ticket with the exact native request', async () => {
    const ticket = {
      uploadUrl: 'https://storage.invalid/upload',
      fields: { key: 'value' },
      runwayUri: 'runway://asset-id',
    };
    const transport = new FakeTransport({ status: 200, data: ticket });
    const connector = new RunwayConnector(transport, 'test-key');

    await expect(connector.createEphemeralUpload('clip.mp4')).resolves.toEqual(ticket);
    expect(transport.requests[0]).toMatchObject({
      method: 'POST',
      url: `${RUNWAY_API_ORIGIN}/v1/uploads`,
      body: { filename: 'clip.mp4', type: 'ephemeral' },
    });
  });

  it.each([
    [
      'creation',
      () =>
        new RunwayConnector(new FakeTransport({ status: 200, data: {} }), 'key').imageToVideo({}),
    ],
    [
      'task',
      () =>
        new RunwayConnector(
          new FakeTransport({
            status: 200,
            data: { status: 'PENDING', createdAt: '2026-07-11T00:00:00Z' },
          }),
          'key',
        ).getTask('task-id'),
    ],
    [
      'upload',
      () =>
        new RunwayConnector(
          new FakeTransport({ status: 200, data: { uploadUrl: 'x', fields: {} } }),
          'key',
        ).createEphemeralUpload('clip.mp4'),
    ],
  ])('rejects a malformed %s response envelope', async (_name, call) => {
    await expect(call()).rejects.toThrow(/Runway.*response/i);
  });

  it('rejects an undocumented task status', async () => {
    const transport = new FakeTransport({
      status: 200,
      data: { id: 'task-id', status: 'QUEUED', createdAt: '2026-07-11T00:00:00Z' },
    });
    const connector = new RunwayConnector(transport, 'test-key');

    await expect(connector.getTask('task-id')).rejects.toThrow(/task response/i);
  });

  it.each(['', '   ', 'task/id'])('rejects unsafe task id %j before transport', async (id) => {
    const transport = new FakeTransport({ status: 200, data: {} });
    const connector = new RunwayConnector(transport, 'test-key');

    await expect(connector.getTask(id)).rejects.toThrow(/task id/i);
    expect(transport.requests).toHaveLength(0);
  });

  it('propagates transport failures without retrying a paid creation', async () => {
    const failure = new Error('HTTP 429');
    const transport: RunwayHttpTransport = { request: vi.fn().mockRejectedValue(failure) };
    const connector = new RunwayConnector(transport, 'test-key');

    await expect(connector.textToVideo({ model: 'gen4.5' })).rejects.toBe(failure);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it('supports an injected base origin without claiming a Runway region', async () => {
    const transport = new FakeTransport({ status: 200, data: { id: 'task-id' } });
    const connector = new RunwayConnector(transport, 'test-key', 'https://proxy.internal');

    await connector.imageToVideo({ model: 'gen4.5' });
    expect(transport.requests[0]?.url).toBe('https://proxy.internal/v1/image_to_video');
  });
});
