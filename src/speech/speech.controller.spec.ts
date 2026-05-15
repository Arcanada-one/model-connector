import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SpeechController } from './speech.controller';
import { SpeechService, ProxyOutcome } from './speech.service';
import { STT_STUB_RESPONSE } from './dto/speech-response.dto';

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

describe('SpeechController', () => {
  let controller: SpeechController;
  let serviceMock: {
    tts: ReturnType<typeof vi.fn>;
    vad: ReturnType<typeof vi.fn>;
    stt: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    serviceMock = { tts: vi.fn(), vad: vi.fn(), stt: vi.fn() };
    controller = new SpeechController(serviceMock as unknown as SpeechService);
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

  it('STT throws HttpException with stub envelope', () => {
    serviceMock.stt.mockReturnValueOnce(STT_STUB_RESPONSE);

    expect(() => controller.stt()).toThrow(HttpException);
    try {
      controller.stt();
    } catch (err) {
      if (err instanceof HttpException) {
        expect(err.getStatus()).toBe(501);
        const body = err.getResponse() as { error_code: string; tracking: string };
        expect(body.error_code).toBe('stt_not_yet_routed');
        expect(body.tracking).toBe('TRANS-0037');
      }
    }
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
