import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpeechService } from './speech.service';
import {
  TranscribatorProxy,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from './transcribator.proxy';

describe('SpeechService', () => {
  let service: SpeechService;
  let proxyMock: { proxy: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    proxyMock = { proxy: vi.fn() };
    service = new SpeechService(proxyMock as unknown as TranscribatorProxy);
  });

  it('returns kind=proxied on successful TTS', async () => {
    const fakeResult = {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: new ArrayBuffer(4),
      contentType: 'audio/wav',
    };
    proxyMock.proxy.mockResolvedValueOnce(fakeResult);

    const outcome = await service.tts(
      { text: 'hi', speaker: 'xenia', sample_rate: 24000, speed: 1.0 },
      'req-1',
    );
    expect(outcome.kind).toBe('proxied');
    expect(proxyMock.proxy).toHaveBeenCalledWith('tts', expect.objectContaining({ text: 'hi' }), {
      requestId: 'req-1',
    });
  });

  it('maps UpstreamTimeoutError to 504 envelope', async () => {
    proxyMock.proxy.mockRejectedValueOnce(
      new UpstreamTimeoutError('http://x/v1/speech/tts', 30000),
    );
    const outcome = await service.tts(
      { text: 'hi', speaker: 'xenia', sample_rate: 24000, speed: 1.0 },
      'req-2',
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.envelope.statusCode).toBe(504);
      expect(outcome.envelope.error_code).toBe('upstream_timeout');
    }
  });

  it('maps UpstreamUnavailableError to 502 envelope', async () => {
    proxyMock.proxy.mockRejectedValueOnce(
      new UpstreamUnavailableError('http://x/v1/speech/tts', 502),
    );
    const outcome = await service.tts(
      { text: 'hi', speaker: 'xenia', sample_rate: 24000, speed: 1.0 },
      'req-3',
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.envelope.statusCode).toBe(502);
      expect(outcome.envelope.error_code).toBe('upstream_unavailable');
    }
  });

  it('returns STT stub synchronously without proxy call', () => {
    const envelope = service.stt();
    expect(envelope.statusCode).toBe(501);
    expect(envelope.error_code).toBe('stt_not_yet_routed');
    expect(envelope.tracking).toBe('TRANS-0037');
    expect(proxyMock.proxy).not.toHaveBeenCalled();
  });
});
