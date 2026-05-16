import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { SttRouterService } from './stt-router.service';
import { GroqSttConnector } from './groq-stt.connector';
import { validateEnv } from '../../config/env.schema';
import {
  SttAllProvidersExhausted,
  SttAudioTooLargeError,
  SttUnsupportedMimeError,
} from './stt-pilot.errors';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

// Integration: exercise full SttRouterService → GroqSttConnector → fetch
// pipeline with MSW mocking api.groq.com. Database + metrics are stubbed
// (no Postgres dependency for this spec — DB persistence is covered by the
// router unit spec).

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

const handlers = [
  http.post(GROQ_URL, async ({ request }) => {
    const auth = request.headers.get('authorization');
    if (!auth?.startsWith('Bearer ')) {
      return HttpResponse.json(
        { error: { code: 'invalid_api_key', message: 'Invalid API Key' } },
        { status: 401 },
      );
    }
    const fd = await request.formData();
    const file = fd.get('file');
    if (!(file instanceof Blob)) {
      return HttpResponse.json(
        { error: { code: 'bad_request', message: 'file field missing' } },
        { status: 400 },
      );
    }
    return HttpResponse.json({
      task: 'transcribe',
      language: 'English',
      duration: 1.337,
      text: ' integration test transcription. ',
      x_groq: { id: 'req_int_test' },
    });
  }),
];

const server = setupServer(...handlers);

function makeReq(overrides: Partial<SttConnectorRequest> = {}): SttConnectorRequest {
  const buf = Buffer.from('RIFFWAVEfmt placeholder');
  return {
    file: buf,
    filename: 'sample.wav',
    mimeType: 'audio/wav',
    audioBytes: buf.length,
    requestId: 'req-integration-1',
    ...overrides,
  };
}

describe('STT pilot integration (CONN-0102 — router → connector → MSW Groq)', () => {
  let router: SttRouterService;
  let prismaStub: {
    sttTranscription: {
      create: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
  };

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  beforeEach(() => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_GROQ_API_KEY: 'gsk_integration_test_key',
      STT_GROQ_MODEL: 'whisper-large-v3',
      STT_GROQ_PRICE_USD_PER_MIN: '0.00185',
      STT_PROVIDERS_ORDER: 'groq',
      STT_PROVIDER_GROQ_ENABLED: 'true',
      STT_DAILY_BUDGET_USD: '10',
      STT_COST_WARN_THRESHOLD_PCT: '0.8',
      STT_MAX_AUDIO_BYTES: '26214400',
    });
    prismaStub = {
      sttTranscription: {
        create: vi.fn().mockResolvedValue(undefined),
        aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
      },
    };
    const metricsStub = { recordStt: vi.fn() };
    const groq = new GroqSttConnector();
    router = new SttRouterService(groq, prismaStub as never, metricsStub as never);
    router.setRegistry(new Map([['groq', groq]]));
  });

  afterEach(() => {
    server.resetHandlers();
  });

  it('returns valid envelope when Groq responds 200 with verbose_json', async () => {
    const envelope = await router.transcribe(makeReq(), 'apikey-int-1');
    expect(envelope.transcription).toBe('integration test transcription.');
    expect(envelope.provider).toBe('groq');
    expect(envelope.model).toBe('whisper-large-v3');
    expect(envelope.language).toBe('en'); // mapped from "English"
    expect(envelope.audio_duration_seconds).toBeCloseTo(1.337);
    expect(envelope.cost_usd).toBeGreaterThan(0);
    expect(envelope.fallback_count).toBe(0);
    expect(envelope.request_id).toBe('req-integration-1');
    expect(prismaStub.sttTranscription.create).toHaveBeenCalledTimes(1);
  });

  it('rejects payload exceeding STT_MAX_AUDIO_BYTES with SttAudioTooLargeError', async () => {
    await expect(
      router.transcribe(makeReq({ audioBytes: 27_000_000 }), 'apikey-int-1'),
    ).rejects.toBeInstanceOf(SttAudioTooLargeError);
  });

  it('rejects unsupported MIME with SttUnsupportedMimeError', async () => {
    await expect(
      router.transcribe(makeReq({ mimeType: 'image/png' }), 'apikey-int-1'),
    ).rejects.toBeInstanceOf(SttUnsupportedMimeError);
  });

  it('throws SttAllProvidersExhausted when Groq returns 401', async () => {
    server.use(
      http.post(GROQ_URL, () =>
        HttpResponse.json({ error: { code: 'invalid_api_key' } }, { status: 401 }),
      ),
    );
    // Override key to a placeholder that MSW handler will reject by absence of Bearer prefix
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_GROQ_API_KEY: 'bad_value',
      STT_PROVIDERS_ORDER: 'groq',
    });
    await expect(router.transcribe(makeReq(), 'apikey-int-1')).rejects.toBeInstanceOf(
      SttAllProvidersExhausted,
    );
    expect(prismaStub.sttTranscription.create).toHaveBeenCalledTimes(1);
    const persisted = prismaStub.sttTranscription.create.mock.calls[0][0].data;
    expect(persisted.status).toBe('error');
    expect(persisted.errorType).toBe('auth_failed');
  });
});
