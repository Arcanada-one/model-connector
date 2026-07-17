import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SttRouterService } from './stt-router.service';
import {
  SttAllProvidersExhausted,
  SttAudioTooLargeError,
  SttBudgetExhaustedError,
  SttProviderError,
  SttUnsupportedMimeError,
} from './stt-pilot.errors';
import { validateEnv } from '../../config/env.schema';
import type {
  ISttConnector,
  SttConnectorRequest,
  SttConnectorResult,
} from './interfaces/stt-connector.interface';

class FakeConnector implements ISttConnector {
  constructor(
    readonly name: string,
    readonly provider: string,
  ) {}
  transcribe = vi.fn<(req: SttConnectorRequest) => Promise<SttConnectorResult>>();
  getStatus = vi.fn();
}

function buildRouter(opts: {
  txOk?: SttConnectorResult;
  txErr?: SttProviderError;
  registry?: Map<string, ISttConnector>;
}) {
  const fakeGroq = new FakeConnector('groq-stt', 'groq');
  const fakeDeepgram = new FakeConnector('deepgram-stt', 'deepgram');
  const fakeAssemblyAi = new FakeConnector('assemblyai-stt', 'assemblyai');
  const fakeOpenAi = new FakeConnector('openai-stt', 'openai');
  const fakeLocalWhisper = new FakeConnector('local-whisper', 'local-whisper');
  if (opts.txOk) fakeGroq.transcribe.mockResolvedValue(opts.txOk);
  if (opts.txErr) fakeGroq.transcribe.mockRejectedValue(opts.txErr);

  const prisma = {
    sttTranscription: {
      create: vi.fn().mockResolvedValue(undefined),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
  };
  const metrics = { recordStt: vi.fn(), incrementSttSchemaFail: vi.fn() };
  const router = new SttRouterService(
    fakeGroq as never,
    fakeDeepgram as never,
    fakeAssemblyAi as never,
    fakeOpenAi as never,
    fakeLocalWhisper as never,
    prisma as never,
    metrics as never,
  );
  if (opts.registry) {
    router.setRegistry(opts.registry);
  } else {
    router.setRegistry(
      new Map<string, ISttConnector>([
        ['groq', fakeGroq],
        ['deepgram', fakeDeepgram],
        ['assemblyai', fakeAssemblyAi],
        ['openai', fakeOpenAi],
        ['local-whisper', fakeLocalWhisper],
      ]),
    );
  }
  return {
    router,
    fakeGroq,
    fakeDeepgram,
    fakeAssemblyAi,
    fakeOpenAi,
    fakeLocalWhisper,
    prisma,
    metrics,
  };
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

const baseEnv = {
  DATABASE_URL: 'postgresql://test',
  STT_MULTI_PROVIDER: 'false',
  STT_PROVIDERS_ORDER: 'groq',
  STT_DAILY_BUDGET_USD: '10',
  STT_COST_WARN_THRESHOLD_PCT: '0.8',
  STT_MAX_AUDIO_BYTES: '26214400',
  // CONN-0103 V-AC-8 — Groq enabled by default; refine requires key.
  STT_GROQ_API_KEY: 'test-groq-key',
};

describe('SttRouterService', () => {
  beforeEach(() => {
    validateEnv(baseEnv);
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
    expect(persisted.fallbackCount).toBe(0);

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

  it('persists error row + throws SttAllProvidersExhausted when provider fails (multi=false)', async () => {
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
    validateEnv({ ...baseEnv, STT_PROVIDER_GROQ_ENABLED: 'false' });
    const { router } = buildRouter({});
    await expect(router.transcribe(makeReq(), 'apikey-1')).rejects.toBeInstanceOf(
      SttAllProvidersExhausted,
    );
  });

  it('routes to enabled local Whisper when external providers are unavailable', async () => {
    validateEnv({
      ...baseEnv,
      STT_PROVIDERS_ORDER: 'local-whisper',
      STT_PROVIDER_GROQ_ENABLED: 'false',
      STT_PROVIDER_LOCAL_WHISPER_ENABLED: 'true',
    });
    const ctx = buildRouter({});
    ctx.fakeLocalWhisper.transcribe.mockResolvedValueOnce({
      transcription: 'recovered locally',
      audioDurationSeconds: 1,
      detectedLanguage: 'ru',
      model: 'Systran/faster-distil-whisper-large-v3',
      costUsd: 0,
      latencyMs: 100,
      providerRequestId: 'local-1',
    });

    const envelope = await ctx.router.transcribe(makeReq(), 'apikey-1');

    expect(envelope.provider).toBe('local-whisper');
    expect(envelope.transcription).toBe('recovered locally');
    expect(ctx.fakeLocalWhisper.transcribe).toHaveBeenCalledTimes(1);
  });

  it('emits soft warning when daily cost crosses 80% threshold (no 503)', async () => {
    const result: SttConnectorResult = {
      transcription: 'x',
      audioDurationSeconds: 1,
      model: 'whisper-large-v3',
      costUsd: 0.00003,
      latencyMs: 100,
    };
    const { router, prisma } = buildRouter({ txOk: result });
    // Aggregate returns $8.50 — above 80% of $10 = $8 but below hard cap.
    prisma.sttTranscription.aggregate.mockResolvedValue({ _sum: { costUsd: 8.5 } });
    const warnSpy = vi.spyOn(router['logger'], 'warn').mockImplementation(() => undefined);
    const envelope = await router.transcribe(makeReq(), 'apikey-1');
    expect(envelope.transcription).toBe('x');
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

  // CONN-0103 — hard daily-cost CB (V-AC-2)
  it('throws SttBudgetExhaustedError before any provider call when daily cost ≥ budget', async () => {
    const { router, prisma, fakeGroq, metrics } = buildRouter({
      txOk: {
        transcription: 'never reached',
        model: 'whisper-large-v3',
        costUsd: 0,
        latencyMs: 0,
      },
    });
    prisma.sttTranscription.aggregate.mockResolvedValue({ _sum: { costUsd: 10.5 } });
    await expect(router.transcribe(makeReq(), 'apikey-1')).rejects.toMatchObject({
      name: 'SttBudgetExhaustedError',
      dailyCostUsd: 10.5,
      budgetUsd: 10,
    });
    await expect(router.transcribe(makeReq(), 'apikey-1')).rejects.toBeInstanceOf(
      SttBudgetExhaustedError,
    );
    expect(fakeGroq.transcribe).not.toHaveBeenCalled();
    expect(metrics.recordStt).not.toHaveBeenCalled();
  });

  // CONN-0103 remediation — V-AC-2 envelope parity: SttBudgetExhaustedError carries providersTried: []
  it('SttBudgetExhaustedError exposes providersTried (empty at hard-CB gate)', async () => {
    const { router, prisma } = buildRouter({});
    prisma.sttTranscription.aggregate.mockResolvedValue({ _sum: { costUsd: 10.5 } });
    await expect(router.transcribe(makeReq(), 'apikey-1')).rejects.toMatchObject({
      name: 'SttBudgetExhaustedError',
      providersTried: [],
    });
  });

  // CONN-0103 — cascade fallback (V-AC-3)
  it('cascades to next provider when first fails with retryable SttProviderError (multi=true)', async () => {
    validateEnv({
      ...baseEnv,
      STT_MULTI_PROVIDER: 'true',
      STT_PROVIDERS_ORDER: 'groq,deepgram',
      STT_PROVIDER_DEEPGRAM_ENABLED: 'true',
      STT_DEEPGRAM_API_KEY: 'dg_test_key',
    });
    const ctx = buildRouter({});
    ctx.fakeGroq.transcribe.mockRejectedValueOnce(
      new SttProviderError('groq', 'server_error', 'boom'),
    );
    ctx.fakeDeepgram.transcribe.mockResolvedValueOnce({
      transcription: 'from deepgram',
      audioDurationSeconds: 1,
      detectedLanguage: 'en',
      model: 'nova-3',
      costUsd: 0.00007,
      latencyMs: 220,
      providerRequestId: 'dg-req-1',
    });
    const envelope = await ctx.router.transcribe(makeReq(), 'apikey-1');
    expect(envelope.provider).toBe('deepgram');
    expect(envelope.fallback_count).toBe(1);
    expect(ctx.fakeGroq.transcribe).toHaveBeenCalledTimes(1);
    expect(ctx.fakeDeepgram.transcribe).toHaveBeenCalledTimes(1);
  });

  it('throws SttAllProvidersExhausted with providersTried when every cascade step fails (multi=true)', async () => {
    validateEnv({
      ...baseEnv,
      STT_MULTI_PROVIDER: 'true',
      STT_PROVIDERS_ORDER: 'groq,deepgram',
      STT_PROVIDER_DEEPGRAM_ENABLED: 'true',
      STT_DEEPGRAM_API_KEY: 'dg_test_key',
    });
    const ctx = buildRouter({});
    ctx.fakeGroq.transcribe.mockRejectedValue(
      new SttProviderError('groq', 'server_error', 'boom-1'),
    );
    ctx.fakeDeepgram.transcribe.mockRejectedValue(
      new SttProviderError('deepgram', 'server_error', 'boom-2'),
    );
    await ctx.router.transcribe(makeReq(), 'apikey-1').catch((err) => {
      expect(err).toBeInstanceOf(SttAllProvidersExhausted);
      expect((err as SttAllProvidersExhausted).providersTried).toEqual(['groq', 'deepgram']);
    });
  });

  // CONN-0103 — drift detection (V-AC-4)
  it('treats Zod schema_fail as retryable and cascades + persists driftStatus=schema_fail', async () => {
    validateEnv({
      ...baseEnv,
      STT_MULTI_PROVIDER: 'true',
      STT_PROVIDERS_ORDER: 'deepgram,groq',
      STT_PROVIDER_DEEPGRAM_ENABLED: 'true',
      STT_DEEPGRAM_API_KEY: 'dg_test_key',
    });
    const ctx = buildRouter({});
    // Deepgram returns malformed result (missing providerRequestId -> empty string → schema fail).
    // Our projection requires metadata.request_id to be min(1); empty string trips Zod.
    ctx.fakeDeepgram.transcribe.mockResolvedValueOnce({
      transcription: 'drifted',
      audioDurationSeconds: 1,
      model: 'nova-3',
      costUsd: 0.00007,
      latencyMs: 220,
      // providerRequestId left undefined to trigger schema_fail
    });
    ctx.fakeGroq.transcribe.mockResolvedValueOnce({
      transcription: 'fallback-groq',
      audioDurationSeconds: 1,
      detectedLanguage: 'en',
      model: 'whisper-large-v3',
      costUsd: 0.00003,
      latencyMs: 1300,
      providerRequestId: 'req_xyz',
    });
    const envelope = await ctx.router.transcribe(makeReq(), 'apikey-1');
    expect(envelope.provider).toBe('groq');
    expect(envelope.fallback_count).toBe(1);
    // Drift row persisted as error w/ driftStatus=schema_fail
    const driftRows = ctx.prisma.sttTranscription.create.mock.calls
      .map((c) => c[0].data)
      .filter((d) => d.driftStatus === 'schema_fail');
    expect(driftRows.length).toBeGreaterThanOrEqual(1);
    expect(driftRows[0].errorType).toBe('drift');
    // CONN-0103 remediation — named drift counter `stt_response_schema_fail_total{provider}`.
    expect(ctx.metrics.incrementSttSchemaFail).toHaveBeenCalledWith('deepgram');
  });

  it('persists driftStatus=schema_pass on a clean Deepgram success', async () => {
    validateEnv({
      ...baseEnv,
      STT_PROVIDERS_ORDER: 'deepgram',
      STT_PROVIDER_GROQ_ENABLED: 'false',
      STT_PROVIDER_DEEPGRAM_ENABLED: 'true',
      STT_DEEPGRAM_API_KEY: 'dg_test_key',
    });
    const ctx = buildRouter({});
    ctx.fakeDeepgram.transcribe.mockResolvedValueOnce({
      transcription: 'ok',
      audioDurationSeconds: 1,
      detectedLanguage: 'en',
      model: 'nova-3',
      costUsd: 0.00007,
      latencyMs: 220,
      providerRequestId: 'dg-pass',
    });
    const envelope = await ctx.router.transcribe(makeReq(), 'apikey-1');
    expect(envelope.provider).toBe('deepgram');
    const persisted = ctx.prisma.sttTranscription.create.mock.calls[0][0].data;
    expect(persisted.driftStatus).toBe('schema_pass');
  });
});
