import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TranscribatorProxy,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from './transcribator.proxy';

const WAV_HEADER = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;

describe('TranscribatorProxy', () => {
  let proxy: TranscribatorProxy;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost/db';
    process.env.TRANSCRIBATOR_API_URL = 'http://upstream.test';
    process.env.SPEECH_INTERNAL_TOKEN = 'a-secret-token-at-least-16-chars';
    process.env.SPEECH_PROXY_TIMEOUT_MS = '5000';
    vi.resetModules();
    proxy = new TranscribatorProxy();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TRANSCRIBATOR_API_URL;
    delete process.env.SPEECH_INTERNAL_TOKEN;
    delete process.env.SPEECH_PROXY_TIMEOUT_MS;
  });

  function mockOk(status: number, body: ArrayBuffer, contentType: string): void {
    fetchSpy.mockResolvedValueOnce({
      ok: status < 400,
      status,
      headers: new Headers({ 'content-type': contentType, 'x-speech-backend': 'silero' }),
      arrayBuffer: () => Promise.resolve(body),
    });
  }

  function mockUpstream(status: number, body = new ArrayBuffer(0)): void {
    fetchSpy.mockResolvedValueOnce({
      ok: status < 400,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: () => Promise.resolve(body),
    });
  }

  function mockTimeout(): void {
    fetchSpy.mockImplementationOnce(() => {
      const err = new DOMException('timeout', 'TimeoutError');
      return Promise.reject(err);
    });
  }

  describe('happy path', () => {
    it('streams 200 audio/wav from upstream', async () => {
      mockOk(200, WAV_HEADER, 'audio/wav');
      const result = await proxy.proxy('tts', { text: 'hi' }, { requestId: 'req-1' });
      expect(result.status).toBe(200);
      expect(result.contentType).toBe('audio/wav');
      expect(result.body.byteLength).toBe(4);
      expect(result.headers['x-speech-backend']).toBe('silero');
    });

    it('passes through upstream 501 stub for VAD', async () => {
      mockUpstream(501);
      const result = await proxy.proxy('vad', { audio_base64: 'AAAA' }, { requestId: 'req-2' });
      expect(result.status).toBe(501);
    });
  });

  describe('headers', () => {
    it('sends Authorization Bearer with internal token', async () => {
      mockOk(200, WAV_HEADER, 'audio/wav');
      await proxy.proxy('tts', { text: 'hi' }, { requestId: 'req-3' });
      const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer a-secret-token-at-least-16-chars');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Request-ID']).toBe('req-3');
    });

    it('omits Authorization when SPEECH_INTERNAL_TOKEN is unset', async () => {
      delete process.env.SPEECH_INTERNAL_TOKEN;
      vi.resetModules();
      const freshProxy = new TranscribatorProxy();
      mockOk(200, WAV_HEADER, 'audio/wav');
      await freshProxy.proxy('tts', { text: 'hi' }, { requestId: 'req-4' });
      const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('only forwards allowlisted response headers', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'audio/wav',
          'set-cookie': 'leak=secret',
          'x-internal-debug': 'should-not-pass',
          'x-speech-model-version': 'v5_5_ru',
        }),
        arrayBuffer: () => Promise.resolve(WAV_HEADER),
      });
      const result = await proxy.proxy('tts', { text: 'hi' }, { requestId: 'req-5' });
      expect(result.headers['x-speech-model-version']).toBe('v5_5_ru');
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(result.headers['x-internal-debug']).toBeUndefined();
    });
  });

  describe('URL construction', () => {
    it('builds /v1/speech/<endpoint> URL', async () => {
      mockOk(200, WAV_HEADER, 'audio/wav');
      await proxy.proxy('tts', { text: 'hi' }, { requestId: 'req-6' });
      expect(fetchSpy.mock.calls[0][0]).toBe('http://upstream.test/v1/speech/tts');
    });

    it('strips trailing slash from base URL', async () => {
      process.env.TRANSCRIBATOR_API_URL = 'http://upstream.test/';
      vi.resetModules();
      const freshProxy = new TranscribatorProxy();
      mockOk(200, WAV_HEADER, 'audio/wav');
      await freshProxy.proxy('vad', { audio_base64: 'AAAA' }, { requestId: 'req-7' });
      expect(fetchSpy.mock.calls[0][0]).toBe('http://upstream.test/v1/speech/vad');
    });
  });

  describe('retry policy', () => {
    it('retries once on 502 and returns 200 on second attempt', async () => {
      mockUpstream(502);
      mockOk(200, WAV_HEADER, 'audio/wav');
      const result = await proxy.proxy('tts', { text: 'hi' }, { requestId: 'req-8' });
      expect(result.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws UpstreamUnavailableError after 502+502', async () => {
      mockUpstream(502);
      mockUpstream(502);
      await expect(
        proxy.proxy('tts', { text: 'hi' }, { requestId: 'req-9' }),
      ).rejects.toBeInstanceOf(UpstreamUnavailableError);
    });

    it('retries once on network error then succeeds', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'));
      mockOk(200, WAV_HEADER, 'audio/wav');
      const result = await proxy.proxy('tts', { text: 'hi' }, { requestId: 'req-10' });
      expect(result.status).toBe(200);
    });
  });

  describe('timeout', () => {
    it('throws UpstreamTimeoutError when fetch raises TimeoutError', async () => {
      mockTimeout();
      await expect(
        proxy.proxy('tts', { text: 'hi' }, { requestId: 'req-11' }),
      ).rejects.toBeInstanceOf(UpstreamTimeoutError);
    });
  });
});
