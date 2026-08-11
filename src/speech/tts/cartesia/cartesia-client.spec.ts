import { describe, expect, it, vi } from 'vitest';
import { CartesiaClient, CartesiaProviderError } from './cartesia-client';
import type { CartesiaHttpPort, CartesiaWebSocketPort } from './ports';

const http = (): CartesiaHttpPort => ({ request: vi.fn() });
const ws = (): CartesiaWebSocketPort => ({ connect: vi.fn() });

describe('CartesiaClient HTTP and discovery contract', () => {
  it('sends versioned bearer-authenticated TTS and returns audio bytes', async () => {
    const transport = http();
    vi.mocked(transport.request).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('audio'),
    });
    const client = new CartesiaClient({ apiKey: 'secret', http: transport, websocket: ws() });

    await expect(
      client.ttsBytes({
        model_id: 'sonic-3.5',
        transcript: 'hello',
        voice: { mode: 'id', id: 'voice-1' },
        output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
      }),
    ).resolves.toEqual(Buffer.from('audio'));
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/tts/bytes',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'Cartesia-Version': '2026-03-01',
        }),
      }),
    );
  });

  it('maps structured provider errors', async () => {
    const transport = http();
    vi.mocked(transport.request).mockResolvedValue({
      status: 429,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          error_code: 'concurrency_limited',
          title: 'Busy',
          message: 'Retry',
          request_id: 'req-1',
        }),
      ),
    });
    const client = new CartesiaClient({ apiKey: 'secret', http: transport, websocket: ws() });
    await expect(client.listVoices({ limit: 10 })).rejects.toMatchObject({
      statusCode: 429,
      errorCode: 'concurrency_limited',
      requestId: 'req-1',
    });
  });

  it('uses voice IDs for cursor pagination and does not expose next_page', async () => {
    const transport = http();
    vi.mocked(transport.request).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          data: [
            {
              id: 'voice-last',
              name: 'Skylar',
              is_owner: false,
              is_public: true,
              language: 'en',
              created_at: '2026-03-31T00:00:00Z',
            },
          ],
          has_more: true,
          next_page: 'deprecated',
        }),
      ),
    });
    const client = new CartesiaClient({ apiKey: 'secret', http: transport, websocket: ws() });
    await expect(
      client.listVoices({ limit: 1, starting_after: 'voice-prev', q: 'sky' }),
    ).resolves.toMatchObject({
      hasMore: true,
      nextCursor: 'voice-last',
    });
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/voices?limit=1&starting_after=voice-prev&q=sky' }),
    );
  });

  it('gets a voice by encoded ID and returns the pinned model catalog without transport', async () => {
    const transport = http();
    vi.mocked(transport.request).mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          id: 'voice/1',
          name: 'Voice',
          is_owner: true,
          is_public: false,
          language: 'en',
          created_at: '2026-03-31T00:00:00Z',
        }),
      ),
    });
    const client = new CartesiaClient({ apiKey: 'secret', http: transport, websocket: ws() });
    await expect(client.getVoice('voice/1')).resolves.toMatchObject({ id: 'voice/1' });
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/voices/voice%2F1' }),
    );
    expect(client.listModels().map((model) => model.id)).toEqual([
      'sonic-3.5',
      'sonic-3',
      'sonic-latest',
    ]);
  });
});

describe('CartesiaClient WebSocket protocol', () => {
  it('uses version query and bearer header, then decodes lifecycle frames', async () => {
    const socket = { send: vi.fn(), close: vi.fn() };
    const websocket = ws();
    vi.mocked(websocket.connect).mockResolvedValue(socket);
    const client = new CartesiaClient({ apiKey: 'secret', http: http(), websocket });
    await client.connectWebSocket();
    expect(websocket.connect).toHaveBeenCalledWith({
      url: 'wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-03-01',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(
      client.parseWebSocketFrame(
        JSON.stringify({
          type: 'chunk',
          data: Buffer.from('pcm').toString('base64'),
          done: false,
          status_code: 206,
          context_id: 'ctx',
        }),
      ),
    ).toMatchObject({ type: 'chunk', audio: Buffer.from('pcm') });
    expect(
      client.parseWebSocketFrame(
        JSON.stringify({ type: 'flush_done', done: false, status_code: 206, context_id: 'ctx' }),
      ),
    ).toMatchObject({ type: 'flush_done' });
    expect(
      client.parseWebSocketFrame(JSON.stringify({ type: 'done', done: true, context_id: 'ctx' })),
    ).toMatchObject({ type: 'done', done: true });
    expect(() =>
      client.parseWebSocketFrame(
        JSON.stringify({
          type: 'error',
          done: true,
          status_code: 400,
          error_code: 'model_not_found',
          title: 'Invalid model',
          message: 'Bad model',
          request_id: 'req',
          context_id: 'ctx',
        }),
      ),
    ).toThrow(CartesiaProviderError);
  });

  it('builds continuation, flush, and cancellation messages and rejects malformed frames', () => {
    const client = new CartesiaClient({ apiKey: 'secret', http: http(), websocket: ws() });
    expect(
      client.generationMessage({
        model_id: 'sonic-3.5',
        transcript: 'part',
        voice: { mode: 'id', id: 'voice' },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
        context_id: 'ctx',
        continue: true,
      }),
    ).toMatchObject({ context_id: 'ctx', continue: true });
    expect(client.flushMessage('ctx')).toEqual({
      context_id: 'ctx',
      transcript: '',
      continue: false,
    });
    expect(client.cancelMessage('ctx')).toEqual({ context_id: 'ctx', cancel: true });
    expect(() => client.parseWebSocketFrame('{bad')).toThrow('Invalid Cartesia WebSocket frame');
    expect(() => client.parseWebSocketFrame(JSON.stringify({ type: 'mystery' }))).toThrow(
      'Unsupported Cartesia WebSocket frame type',
    );
  });
});
