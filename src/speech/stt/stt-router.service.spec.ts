import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SttRouterService } from './stt-router.service';
import {
  SttAllProvidersExhausted,
  SttAudioTooLargeError,
  SttProviderError,
  SttUnsupportedMimeError,
} from './stt-pilot.errors';
import { validateEnv } from '../../config/env.schema';
import type {
  ISttConnector,
  SttConnectorRequest,
  SttConnectorResult,
} from './interfaces/stt-connector.interface';

class FakeGroqStt implements ISttConnector {
  readonly name = 'groq-stt';
  readonly provider = 'groq';
  transcribe = vi.fn<(req: SttConnectorRequest) => Promise<SttConnectorResult>>();
  getStatus = vi.fn();
}

function buildRouter(opts: {
  txOk?: SttConnectorResult;
  txErr?: SttProviderError;
  registry?: Map<string, ISttConnector>;
}) {
  const fakeGroq = new FakeGroqStt();
  if (opts.txOk) fakeGroq.transcribe.mockResolvedValue(opts.txOk);
  if (opts.txErr) fakeGroq.transcribe.mockRejectedValue(opts.txErr);

  const prisma = {
    sttTranscription: {
      create: vi.fn().mockResolvedValue(undefined),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
  };
  const metrics = { recordStt: vi.fn() };
  const router = new SttRouterService(fakeGroq as never, prisma as never, metrics as never);
  if (opts.registry) router.setRegistry(opts.registry);
  else router.setRegistry(new Map([['groq', fakeGroq]]));
  return { router, fakeGroq, prisma, metrics };
}

function makeReq(overrides: Partial<SttConnectorRequest> = {}): SttConnectorRequest {
  const buf = Buffer.from([0x00, 0x01, 0x02]);
  return {
    file: buf,
    mimeType: 'audio/wav',
    audioBytes: buf.length,
    requestId: 'req-router-1',
    ...overrides,
  };
}

describe('SttRouterService', () => {
  beforeEach(() => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_MULTI_PROVIDER: 'false',
      STT_PROVIDERS_ORDER: 'groq',
      STT_DAILY_BUDGET_USD: '10',
      STT_COST_WARN_THRESHOLD_PCT: '0.8',
      STT_MAX_AUDIO_BYTES: '26214400',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns envelope and persists success row on happy path', async () => {
    const result: SttConnectorResult = {
      transcription: 'hello world',
      audioDurationSeconds: 1.5,
      detectedLanguage: 'en',
      model: 'whisper-large-v3',
      costUsd: 0.0000463,
      latencyMs: 1331,
      providerRequestId: 'req_xyz',
    };
    const { router, prisma, metrics } = buildRouter({ txOk: result });
    const envelope = await router.transcribe(makeReq(), 'apikey-1');
    expect(envelope.transcription).toBe('hello world');
    expect(envelope.provider).toBe('groq');
    expect(envelope.model).toBe('whisper-large-v3');
    expect(envelope.language).toBe('en');
    expect(envelope.fallback_count).toBe(0);
    expect(envelope.request_id).toBe('req-router-1');
    expect(envelope.audio_duration_seconds).toBe(1.5);

    expect(prisma.sttTranscription.create).toHaveBeenCalledTimes(1);
    const persisted = prisma.sttTranscription.create.mock.calls[0][0].data;
    expect(persisted.provider).toBe('groq');
    expect(persisted.status).toBe('success');
    expect(persisted.transcriptionPreview).toBe('hello world');
    expect(persisted.apiKeyId).toBe('apikey-1');

    expect(metrics.recordStt).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'groq', status: 'success' }),
    );
  });

  it('throws SttUnsupportedMimeError before calling connector', async () => {
    const { router, fakeGroq } = buildRouter({});
    await expect(
      router.transcribe(makeReq({ mimeType: 'image/png' }), 'apikey-1'),
    ).rejects.toBeInstanceOf(SttUnsupportedMimeError);
    expect(fakeGroq.transcribe).not.toHaveBeenCalled();
  });

  it('throws SttAudioTooLargeError when audioBytes > STT_MAX_AUDIO_BYTES', async () => {
    const { router, fakeGroq } = buildRouter({});
    await expect(
      router.transcribe(makeReq({ audioBytes: 30_000_000 }), 'apikey-1'),
    ).rejects.toBeInstanceOf(SttAudioTooLargeError);
    expect(fakeGroq.transcribe).not.toHaveBeenCalled();
  });

  it('persists error row + throws SttAllProvidersExhausted when provider fails (Phase 1a no cascade)', async () => {
    const err = new SttProviderError('groq', 'server_error', 'boom');
    const { router, prisma } = buildRouter({ txErr: err });
    await expect(router.transcribe(makeReq(), 'apikey-1')).rejects.toBeInstanceOf(
      SttAllProvidersExhausted,
    );
    expect(prisma.sttTranscription.create).toHaveBeenCalledTimes(1);
    const persisted = prisma.sttTranscription.create.mock.calls[0][0].data;
    expect(persisted.status).toBe('error');
    expect(persisted.errorType).toBe('server_error');
  });

  it('throws SttAllProvidersExhausted when STT_PROVIDER_GROQ_ENABLED=false', async () => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_PROVIDER_GROQ_ENABLED: 'false',
    });
    const { router } = buildRouter({});
    await expect(router.transcribe(makeReq(), 'apikey-1')).rejects.toBeInstanceOf(
      SttAllProvidersExhausted,
    );
  });

  it('emits soft warning when daily cost crosses 80% threshold (no 503)', async () => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_DAILY_BUDGET_USD: '10',
      STT_COST_WARN_THRESHOLD_PCT: '0.8',
    });
    const result: SttConnectorResult = {
      transcription: 'x',
      audioDurationSeconds: 1,
      model: 'whisper-large-v3',
      costUsd: 0.00003,
      latencyMs: 100,
    };
    const { router, prisma } = buildRouter({ txOk: result });
    // Aggregate returns $8.50 — above 80% of $10 = $8.
    prisma.sttTranscription.aggregate.mockResolvedValue({ _sum: { costUsd: 8.5 } });
    const warnSpy = vi.spyOn(router['logger'], 'warn').mockImplementation(() => undefined);
    const envelope = await router.transcribe(makeReq(), 'apikey-1');
    expect(envelope.transcription).toBe('x'); // request still succeeded — no 503
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('STT daily cost reached'));
  });

  it('getDailyCostUsd aggregates only today-success rows', async () => {
    const { router, prisma } = buildRouter({});
    prisma.sttTranscription.aggregate.mockResolvedValue({ _sum: { costUsd: 1.23 } });
    const cost = await router.getDailyCostUsd();
    expect(cost).toBe(1.23);
    const call = prisma.sttTranscription.aggregate.mock.calls[0][0];
    expect(call.where.status).toBe('success');
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
  });
});
