import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SpeechController } from './speech.controller';
import { SpeechService, ProxyOutcome } from './speech.service';
import { SttRouterService } from './stt/stt-router.service';
import {
  SttAllProvidersExhausted,
  SttAudioTooLargeError,
  SttProviderError,
  SttUnsupportedMimeError,
} from './stt/stt-pilot.errors';

function makeReply(): { reply: FastifyReply; sent: Record<string, unknown> } {
  const sent: Record<string, unknown> = { headers: {}, body: null, status: null };
  const reply = {
    header: vi.fn((k: string, v: unknown) => {
      (sent.headers as Record<string, unknown>)[k.toLowerCase()] = v;
      return reply;
    }),
    status: vi.fn((s: number) => {
      sent.status = s;
      return reply;
    }),
    send: vi.fn((b: unknown) => {
      sent.body = b;
      return reply;
    }),
  } as unknown as FastifyReply;
  return { reply, sent };
}

// Loose stand-in for AuthenticatedRequest enriched with @fastify/multipart's
// `.file()` accessor. We cast through `unknown` because the real
// FastifyRequest type is too wide for spec stubs.
type MultipartReqStub = FastifyRequest & { apiKey?: { id: string } };

function makeMultipartReq(opts: {
  buffer?: Buffer;
  filename?: string;
  mimetype?: string;
  fields?: Record<string, string>;
  apiKeyId?: string;
  noFile?: boolean;
}): MultipartReqStub {
  const buf = opts.buffer ?? Buffer.from([0x00, 0x01]);
  const fields: Record<string, { value: string }> = {};
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    fields[k] = { value: v };
  }
  const file = opts.noFile
    ? async () => undefined
    : async () => ({
        toBuffer: async () => buf,
        filename: opts.filename ?? 'audio.wav',
        mimetype: opts.mimetype ?? 'audio/wav',
        fields,
      });
  return {
    file,
    apiKey: opts.apiKeyId ? { id: opts.apiKeyId } : undefined,
  } as unknown as MultipartReqStub;
}

describe('SpeechController', () => {
  let controller: SpeechController;
  let serviceMock: {
    tts: ReturnType<typeof vi.fn>;
    vad: ReturnType<typeof vi.fn>;
  };
  let sttRouterMock: { transcribe: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    serviceMock = { tts: vi.fn(), vad: vi.fn() };
    sttRouterMock = { transcribe: vi.fn() };
    controller = new SpeechController(
      serviceMock as unknown as SpeechService,
      sttRouterMock as unknown as SttRouterService,
    );
  });

  it('TTS proxied: forwards status, headers, body to Fastify reply', async () => {
    const outcome: ProxyOutcome = {
      kind: 'proxied',
      result: {
        status: 200,
        headers: { 'content-type': 'audio/wav', 'x-speech-backend': 'silero' },
        body: new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
        contentType: 'audio/wav',
      },
    };
    serviceMock.tts.mockResolvedValueOnce(outcome);

    const { reply, sent } = makeReply();
    await controller.tts(
      { text: 'hi', speaker: 'xenia', sample_rate: 24000, speed: 1.0 },
      'req-test',
      {} as FastifyRequest,
      reply,
    );

    expect(sent.status).toBe(200);
    expect((sent.headers as Record<string, string>)['x-request-id']).toBe('req-test');
    expect((sent.headers as Record<string, string>)['content-type']).toBe('audio/wav');
    expect((sent.headers as Record<string, string>)['x-speech-backend']).toBe('silero');
  });

  it('TTS error: sends JSON envelope with upstream status', async () => {
    const outcome: ProxyOutcome = {
      kind: 'error',
      envelope: {
        statusCode: 502,
        error_code: 'upstream_unavailable',
        message: 'unavailable',
        upstream_url: 'http://x',
      },
    };
    serviceMock.tts.mockResolvedValueOnce(outcome);

    const { reply, sent } = makeReply();
    await controller.tts(
      { text: 'hi', speaker: 'xenia', sample_rate: 24000, speed: 1.0 },
      undefined,
      {} as FastifyRequest,
      reply,
    );

    expect(sent.status).toBe(502);
    expect((sent.body as { error_code: string }).error_code).toBe('upstream_unavailable');
  });

  it('VAD calls service.vad and propagates response', async () => {
    const outcome: ProxyOutcome = {
      kind: 'proxied',
      result: {
        status: 501,
        headers: { 'content-type': 'application/json' },
        body: new ArrayBuffer(0),
        contentType: 'application/json',
      },
    };
    serviceMock.vad.mockResolvedValueOnce(outcome);

    const { reply, sent } = makeReply();
    await controller.vad(
      { audio_base64: 'AAAA', sample_rate: 16000 },
      'req-vad',
      {} as FastifyRequest,
      reply,
    );

    expect(serviceMock.vad).toHaveBeenCalledTimes(1);
    expect(sent.status).toBe(501);
  });

  it('STT happy path: delegates to SttRouterService and sends 200 envelope', async () => {
    const envelope = {
      transcription: 'hello world',
      model: 'whisper-large-v3',
      provider: 'groq' as const,
      language: 'en',
      latency_ms: 1300,
      cost_usd: 0.0000463,
      audio_duration_seconds: 1.5,
      fallback_count: 0,
      request_id: 'req-stt-test',
    };
    sttRouterMock.transcribe.mockResolvedValueOnce(envelope);
    const req = makeMultipartReq({ apiKeyId: 'apikey-1' });
    const { reply, sent } = makeReply();

    await controller.stt('req-stt-test', req, reply);

    expect(sent.status).toBe(200);
    expect((sent.body as typeof envelope).transcription).toBe('hello world');
    expect((sent.headers as Record<string, string>)['x-request-id']).toBe('req-stt-test');
  });

  it('STT missing file: returns 400 stt_validation_error', async () => {
    const req = makeMultipartReq({ apiKeyId: 'apikey-1', noFile: true });
    const { reply, sent } = makeReply();
    await controller.stt(undefined, req, reply);
    expect(sent.status).toBe(400);
    expect((sent.body as { error_code: string }).error_code).toBe('stt_validation_error');
    expect(sttRouterMock.transcribe).not.toHaveBeenCalled();
  });

  it('STT SttAudioTooLargeError → 413 stt_audio_too_large', async () => {
    sttRouterMock.transcribe.mockRejectedValueOnce(
      new SttAudioTooLargeError(30_000_000, 26_214_400),
    );
    const req = makeMultipartReq({ apiKeyId: 'apikey-1' });
    const { reply, sent } = makeReply();
    await controller.stt(undefined, req, reply);
    expect(sent.status).toBe(413);
    expect((sent.body as { error_code: string }).error_code).toBe('stt_audio_too_large');
  });

  it('STT SttUnsupportedMimeError → 400 stt_unsupported_mime', async () => {
    sttRouterMock.transcribe.mockRejectedValueOnce(
      new SttUnsupportedMimeError('image/png', ['audio/wav']),
    );
    const req = makeMultipartReq({ apiKeyId: 'apikey-1' });
    const { reply, sent } = makeReply();
    await controller.stt(undefined, req, reply);
    expect(sent.status).toBe(400);
    expect((sent.body as { error_code: string }).error_code).toBe('stt_unsupported_mime');
  });

  it('STT SttAllProvidersExhausted → 503', async () => {
    sttRouterMock.transcribe.mockRejectedValueOnce(new SttAllProvidersExhausted(['groq']));
    const req = makeMultipartReq({ apiKeyId: 'apikey-1' });
    const { reply, sent } = makeReply();
    await controller.stt(undefined, req, reply);
    expect(sent.status).toBe(503);
    expect((sent.body as { error_code: string }).error_code).toBe('stt_all_providers_exhausted');
  });

  it('STT SttProviderError(rate_limited) → 429 stt_provider_failed', async () => {
    sttRouterMock.transcribe.mockRejectedValueOnce(
      new SttProviderError('groq', 'rate_limited', 'too many'),
    );
    const req = makeMultipartReq({ apiKeyId: 'apikey-1' });
    const { reply, sent } = makeReply();
    await controller.stt(undefined, req, reply);
    expect(sent.status).toBe(429);
    expect((sent.body as { error_code: string }).error_code).toBe('stt_provider_failed');
  });

  it('STT missing apiKey → 401 unauthorized envelope', async () => {
    const req = makeMultipartReq({});
    const { reply, sent } = makeReply();
    await controller.stt(undefined, req, reply);
    expect(sent.status).toBe(401);
  });

  it('generates UUID when X-Request-ID header missing', async () => {
    const outcome: ProxyOutcome = {
      kind: 'proxied',
      result: {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
        body: new ArrayBuffer(0),
        contentType: 'audio/wav',
      },
    };
    serviceMock.tts.mockResolvedValueOnce(outcome);

    const { reply, sent } = makeReply();
    await controller.tts(
      { text: 'hi', speaker: 'xenia', sample_rate: 24000, speed: 1.0 },
      undefined,
      {} as FastifyRequest,
      reply,
    );

    expect((sent.headers as Record<string, string>)['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });
});
