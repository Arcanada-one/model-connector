import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpeechService } from './speech.service';
import {
  TranscribatorProxy,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from './transcribator.proxy';
import { TogetherTtsConnector, TogetherTtsError } from './tts/together-tts.connector';
import {
  DeepgramTtsConnector,
  DeepgramTtsError,
  type DeepgramTtsErrorCode,
} from './tts/deepgram-tts.connector';

const deepgramErrorCases: Array<[number, DeepgramTtsErrorCode]> = [
  [503, 'provider_disabled'],
  [429, 'upstream_rate_limited'],
  [502, 'upstream_authentication_failed'],
  [504, 'upstream_timeout'],
  [502, 'upstream_unavailable'],
];

describe('SpeechService', () => {
  let service: SpeechService;
  let proxyMock: { proxy: ReturnType<typeof vi.fn> };
  let deepgramMock: { synthesize: ReturnType<typeof vi.fn> };
  let togetherMock: { synthesize: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    proxyMock = { proxy: vi.fn() };
    deepgramMock = { synthesize: vi.fn() };
    togetherMock = { synthesize: vi.fn() };
    service = new SpeechService(
      proxyMock as unknown as TranscribatorProxy,
      deepgramMock as unknown as DeepgramTtsConnector,
      togetherMock as unknown as TogetherTtsConnector,
    );
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
    expect(deepgramMock.synthesize).not.toHaveBeenCalled();
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

  it('routes exact Deepgram requests only to the native connector', async () => {
    const fakeResult = {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: new ArrayBuffer(4),
      contentType: 'audio/wav',
    };
    deepgramMock.synthesize.mockResolvedValueOnce(fakeResult);

    const outcome = await service.tts(
      { provider: 'deepgram', model: 'aura-asteria-en', text: 'hello' },
      'req-deepgram',
    );

    expect(outcome).toEqual({ kind: 'proxied', result: fakeResult });
    expect(deepgramMock.synthesize).toHaveBeenCalledWith('aura-asteria-en', 'hello', {
      requestId: 'req-deepgram',
    });
    expect(proxyMock.proxy).not.toHaveBeenCalled();
  });

  it('routes Luna through the same native connector with its exact model ID', async () => {
    const fakeResult = {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: new ArrayBuffer(4),
      contentType: 'audio/wav',
    };
    deepgramMock.synthesize.mockResolvedValueOnce(fakeResult);

    const outcome = await service.tts(
      { provider: 'deepgram', model: 'aura-luna-en', text: 'hello' },
      'req-luna',
    );

    expect(outcome).toEqual({ kind: 'proxied', result: fakeResult });
    expect(deepgramMock.synthesize).toHaveBeenCalledWith('aura-luna-en', 'hello', {
      requestId: 'req-luna',
    });
    expect(proxyMock.proxy).not.toHaveBeenCalled();
  });

  it('routes Stella through the same native connector with its exact model ID', async () => {
    const fakeResult = {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: new ArrayBuffer(4),
      contentType: 'audio/wav',
    };
    deepgramMock.synthesize.mockResolvedValueOnce(fakeResult);

    const outcome = await service.tts(
      { provider: 'deepgram', model: 'aura-stella-en', text: 'hello' },
      'req-stella',
    );

    expect(outcome).toEqual({ kind: 'proxied', result: fakeResult });
    expect(deepgramMock.synthesize).toHaveBeenCalledWith('aura-stella-en', 'hello', {
      requestId: 'req-stella',
    });
    expect(proxyMock.proxy).not.toHaveBeenCalled();
  });

  it.each(deepgramErrorCases)('sanitizes a Deepgram %i/%s error', async (statusCode, errorCode) => {
    deepgramMock.synthesize.mockRejectedValueOnce(
      new DeepgramTtsError(statusCode, errorCode, 'Safe provider failure.', 429),
    );

    const outcome = await service.tts(
      { provider: 'deepgram', model: 'aura-asteria-en', text: 'hello' },
      'req-sanitized',
    );

    expect(outcome).toEqual({
      kind: 'error',
      envelope: {
        statusCode,
        error_code: errorCode,
        message: 'Safe provider failure.',
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('test-deepgram-key');
    expect(JSON.stringify(outcome)).not.toContain('api.deepgram.com');
    expect(proxyMock.proxy).not.toHaveBeenCalled();
  });

  it('routes the exact Together Orpheus request without touching the legacy proxy', async () => {
    const fakeResult = {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
      contentType: 'audio/wav',
    };
    togetherMock.synthesize.mockResolvedValueOnce(fakeResult);

    const outcome = await service.tts(
      {
        provider: 'together',
        model: 'canopylabs/orpheus-3b-0.1-ft',
        text: 'Hello',
        voice: 'tara',
      },
      'req-together',
    );

    expect(outcome).toEqual({ kind: 'proxied', result: fakeResult });
    expect(togetherMock.synthesize).toHaveBeenCalledWith(
      {
        provider: 'together',
        model: 'canopylabs/orpheus-3b-0.1-ft',
        text: 'Hello',
        voice: 'tara',
      },
      { requestId: 'req-together' },
    );
    expect(proxyMock.proxy).not.toHaveBeenCalled();
  });

  it('routes exact Cartesia Sonic 2 requests through the shared Together transport', async () => {
    const request = {
      provider: 'together' as const,
      model: 'cartesia/sonic-2' as const,
      text: 'Hello',
      voice: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
    };
    const fakeResult = {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: new ArrayBuffer(4),
      contentType: 'audio/wav',
    };
    togetherMock.synthesize.mockResolvedValueOnce(fakeResult);

    const outcome = await service.tts(request, 'req-cartesia');

    expect(outcome).toEqual({ kind: 'proxied', result: fakeResult });
    expect(togetherMock.synthesize).toHaveBeenCalledWith(request, {
      requestId: 'req-cartesia',
    });
    expect(proxyMock.proxy).not.toHaveBeenCalled();
  });

  it('maps Together provider errors to the safe speech envelope', async () => {
    togetherMock.synthesize.mockRejectedValueOnce(
      new TogetherTtsError(429, 'upstream_rate_limited', 'Together TTS rate limit reached.', 429),
    );

    const outcome = await service.tts(
      {
        provider: 'together',
        model: 'canopylabs/orpheus-3b-0.1-ft',
        text: 'Hello',
        voice: 'tara',
      },
      'req-rate-limit',
    );

    expect(outcome).toEqual({
      kind: 'error',
      envelope: {
        statusCode: 429,
        error_code: 'upstream_rate_limited',
        message: 'Together TTS rate limit reached.',
      },
    });
  });

  // STT moved out of SpeechService to SttRouterService per CONN-0102 —
  // no `.stt()` method here anymore. Coverage lives in stt-router.service.spec.ts
  // and the SpeechController STT-route spec below.
});
