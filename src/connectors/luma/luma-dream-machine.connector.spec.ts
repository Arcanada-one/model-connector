import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LumaDreamMachineConnector,
  type LumaGeneration,
  type LumaHttpTransport,
} from './luma-dream-machine.connector';

describe('LumaDreamMachineConnector', () => {
  const request = vi.fn<LumaHttpTransport['request']>();
  let connector: LumaDreamMachineConnector;

  beforeEach(() => {
    request.mockReset();
    connector = new LumaDreamMachineConnector('luma-test-key', { request });
  });

  it('creates video through the explicit video endpoint with documented fields', async () => {
    request.mockResolvedValue(generation({ state: 'dreaming' }));
    const body = {
      prompt: 'A synthetic test scene',
      model: 'ray-2' as const,
      aspect_ratio: '16:9' as const,
      loop: false,
      resolution: '720p',
      duration: '5s',
      concepts: [{ key: 'dolly_zoom' }],
      callback_url: 'https://example.com/luma-callback',
    };

    await expect(connector.createVideo(body)).resolves.toMatchObject({ state: 'dreaming' });
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.lumalabs.ai/dream-machine/v1/generations/video',
      headers: jsonHeaders(),
      body,
    });
  });

  it('keeps image creation on its distinct endpoint and request contract', async () => {
    request.mockResolvedValue(
      generation({ state: 'completed', assets: { image: 'https://example.com/image.jpg' } }),
    );
    const body = {
      prompt: 'A synthetic image',
      model: 'photon-flash-1' as const,
      aspect_ratio: '3:4' as const,
      format: 'png' as const,
      image_ref: [{ url: 'https://example.com/reference.jpg', weight: 0.8 }],
      callback_url: 'https://example.com/image-callback',
    };

    await connector.createImage(body);
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.lumalabs.ai/dream-machine/v1/generations/image',
      headers: jsonHeaders(),
      body,
    });
  });

  it('supports image start/end keyframes without changing their shape', async () => {
    request.mockResolvedValue(generation());
    const keyframes = {
      frame0: { type: 'image' as const, url: 'https://example.com/start.jpg' },
      frame1: { type: 'image' as const, url: 'https://example.com/end.jpg' },
    };

    await connector.createVideo({ prompt: 'Transition', model: 'ray-2', keyframes });
    expect(request.mock.calls[0]?.[0].body).toMatchObject({ keyframes });
  });

  it('extends a completed generated video through a generation keyframe', async () => {
    request.mockResolvedValue(generation());
    const source = generation({ id: 'source-id', state: 'completed' });

    await connector.extendVideo(source, {
      direction: 'forward',
      prompt: 'Continue the scene',
      model: 'ray-flash-2',
    });

    expect(request.mock.calls[0]?.[0].body).toEqual({
      prompt: 'Continue the scene',
      model: 'ray-flash-2',
      keyframes: { frame0: { type: 'generation', id: 'source-id' } },
    });
  });

  it('uses frame1 for reverse extension', async () => {
    request.mockResolvedValue(generation());
    await connector.extendVideo(generation({ id: 'source-id', state: 'completed' }), {
      direction: 'reverse',
      prompt: 'Lead into the scene',
      model: 'ray-2',
    });
    expect(request.mock.calls[0]?.[0].body).toMatchObject({
      keyframes: { frame1: { type: 'generation', id: 'source-id' } },
    });
  });

  it('rejects extension of a source not reported completed without transport I/O', async () => {
    await expect(
      connector.extendVideo(generation({ state: 'dreaming' }), {
        direction: 'forward',
        prompt: 'Continue',
        model: 'ray-2',
      }),
    ).rejects.toThrow('completed');
    expect(request).not.toHaveBeenCalled();
  });

  it('retrieves a generation with an encoded path segment', async () => {
    request.mockResolvedValue(generation());
    await connector.getGeneration('id/with space');
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.lumalabs.ai/dream-machine/v1/generations/id%2Fwith%20space',
      headers: authHeaders(),
    });
  });

  it('lists history with documented limit and offset query parameters', async () => {
    request.mockResolvedValue({ generations: [generation()], extra: 'preserved' });
    await expect(connector.listGenerations({ limit: 10, offset: 20 })).resolves.toMatchObject({
      extra: 'preserved',
    });
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.lumalabs.ai/dream-machine/v1/generations?limit=10&offset=20',
      headers: authHeaders(),
    });
  });

  it('does not invent pagination parameters when none are supplied', async () => {
    request.mockResolvedValue({ generations: [] });
    await connector.listGenerations();
    expect(request.mock.calls[0]?.[0].url).toBe(
      'https://api.lumalabs.ai/dream-machine/v1/generations',
    );
  });

  it.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ offset: -1 }, 'offset'],
  ])('rejects invalid pagination %j before transport I/O', async (pagination, field) => {
    await expect(connector.listGenerations(pagination)).rejects.toThrow(field);
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves documented failed state, failure reason, assets, and unknown fields', async () => {
    const failed = generation({
      state: 'failed',
      failure_reason: 'synthetic failure',
      assets: { video: null, image: null },
      provider_extension: { retained: true },
    });
    request.mockResolvedValue(failed);
    await expect(connector.getGeneration('failed-id')).resolves.toEqual(failed);
  });

  it('allows an unknown future state without fabricating a closed provider enum', async () => {
    request.mockResolvedValue(generation({ state: 'future-provider-state' }));
    await expect(connector.getGeneration('future-id')).resolves.toMatchObject({
      state: 'future-provider-state',
    });
  });

  it('rejects an empty API key before any request', () => {
    expect(() => new LumaDreamMachineConnector('   ', { request })).toThrow('API key');
  });

  function authHeaders(): Record<string, string> {
    return { Accept: 'application/json', Authorization: 'Bearer luma-test-key' };
  }

  function jsonHeaders(): Record<string, string> {
    return { ...authHeaders(), 'Content-Type': 'application/json' };
  }
});

function generation(overrides: Partial<LumaGeneration> = {}): LumaGeneration {
  return {
    id: 'generation-id',
    state: 'completed',
    failure_reason: null,
    created_at: '2026-07-11T00:00:00Z',
    assets: { video: 'https://example.com/video.mp4' },
    request: { prompt: 'Synthetic fixture' },
    ...overrides,
  };
}
