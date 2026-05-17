import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { FastifyReply } from 'fastify';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { SpeechMetricsService } from '../speech/speech-metrics.service';
import { MetricsController } from './metrics.controller';

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

describe('MetricsController', () => {
  let speechMetrics: SpeechMetricsService;
  let controller: MetricsController;

  beforeEach(() => {
    speechMetrics = new SpeechMetricsService();
    controller = new MetricsController(speechMetrics);
  });

  it('serves Prometheus text format with both speech-proxy series after an observation', async () => {
    speechMetrics.observe({ endpoint: 'tts', statusCode: 200, latencyMs: 120 });
    const { reply, sent } = makeReply();

    await controller.metrics(reply);

    expect(sent.status).toBe(200);
    expect((sent.headers as Record<string, string>)['content-type']).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    const body = sent.body as string;
    expect(body).toContain('mc_speech_proxy_total');
    expect(body).toContain('mc_speech_proxy_latency_ms');
    expect(body).toMatch(
      /mc_speech_proxy_total\{[^}]*endpoint="tts"[^}]*status_class="2xx"[^}]*\} 1/,
    );
  });

  it('still serves the response shape when no observations have been recorded yet', async () => {
    const { reply, sent } = makeReply();

    await controller.metrics(reply);

    expect(sent.status).toBe(200);
    // prom-client emits HELP/TYPE lines even with zero observations.
    const body = sent.body as string;
    expect(body).toContain('# HELP mc_speech_proxy_total');
    expect(body).toContain('# HELP mc_speech_proxy_latency_ms');
  });

  it('handler is NOT marked @Public() — AuthGuard must enforce Bearer', () => {
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      controller.metrics,
      MetricsController,
    ]);
    expect(isPublic ?? false).toBe(false);
  });
});
