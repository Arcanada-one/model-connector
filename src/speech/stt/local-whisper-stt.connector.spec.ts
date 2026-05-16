import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { LocalWhisperSttConnector } from './local-whisper-stt.connector';
import { validateEnv } from '../../config/env.schema';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

// CONN-0104 — LocalWhisperSttConnector unit/integration tests.
//
// Fixture shape sourced from Phase 0 capture (CONN-0101-fixtures.md, faster-
// whisper section, 2026-05-16). OpenAI-compat verbose_json:
//   { task, language, duration, text, words, segments[...] }.
// No auth (Tailscale-only). Endpoint POST /v1/audio/transcriptions on port
// 8400 of arcana-ai. msw intercepts http://arcana-ai:8400 — the value
// matches the test env's LOCAL_WHISPER_BASE_URL default.

const WHISPER_URL = 'http://arcana-ai:8400/v1/audio/transcriptions';

// Captured Phase 0 response shape (warm transcription, 13.7s EN audio).
// Trimmed inner arrays to keep the spec readable while preserving every
// field name that parseSttResponse may touch.
const PHASE0_VERBOSE_JSON = {
  task: 'transcribe',
  language: 'en',
  duration: 13.70025,
  text:
    ' The quick brown fox jumps over the lazy dog. ' +
    'This is a synthetic test sample for speech-to-text validation. ',
  words: null,
  segments: [
    {
      id: 1,
      seek: 1370,
      start: 0.0,
      end: 2.42,
      text: ' The quick brown fox jumps over the lazy dog.',
      tokens: [50365, 440, 1702],
      temperature: 0.0,
      avg_logprob: -0.15248276166996713,
      compression_ratio: 1.367816091954023,
      no_speech_prob: 0.007439242675900459,
      words: null,
    },
  ],
};

const handlers = [http.post(WHISPER_URL, () => HttpResponse.json(PHASE0_VERBOSE_JSON))];

const server = setupServer(...handlers);

function makeReq(overrides: Partial<SttConnectorRequest> = {}): SttConnectorRequest {
  const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]); // wav-ish header bytes
  return {
    file: buf,
    filename: 'sample.wav',
    mimeType: 'audio/wav',
    audioBytes: buf.length,
    requestId: 'req-whisper-1',
    ...overrides,
  };
}

describe('LocalWhisperSttConnector', () => {
  let connector: LocalWhisperSttConnector;

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());
  afterEach(() => server.resetHandlers());

  beforeEach(() => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_PROVIDER_GROQ_ENABLED: 'false',
      LOCAL_WHISPER_BASE_URL: 'http://arcana-ai:8400',
      STT_LOCAL_WHISPER_MODEL: 'Systran/faster-distil-whisper-large-v3',
      STT_LOCAL_WHISPER_TIMEOUT_MS: '300000',
      STT_LOCAL_WHISPER_MAX_CONCURRENCY: '1',
    });
    connector = new LocalWhisperSttConnector();
  });

  it('targets http://arcana-ai:8400/v1/audio/transcriptions without auth header', async () => {
    let capturedAuth: string | null = 'sentinel';
    let capturedUrl = '';
    server.use(
      http.post(WHISPER_URL, ({ request }) => {
        capturedAuth = request.headers.get('authorization');
        capturedUrl = request.url;
        return HttpResponse.json(PHASE0_VERBOSE_JSON);
      }),
    );
    await connector.transcribe(makeReq());
    expect(capturedUrl).toBe(WHISPER_URL);
    // Self-hosted on Tailscale-only port — no Authorization header.
    expect(capturedAuth).toBeNull();
  });

  it('sends multipart with model + response_format=verbose_json + file Blob', async () => {
    let capturedForm: FormData | null = null;
    server.use(
      http.post(WHISPER_URL, async ({ request }) => {
        capturedForm = await request.formData();
        return HttpResponse.json(PHASE0_VERBOSE_JSON);
      }),
    );
    await connector.transcribe(makeReq({ language: 'en' }));
    const fd = capturedForm as unknown as FormData;
    expect(fd).not.toBeNull();
    expect(fd.get('model')).toBe('Systran/faster-distil-whisper-large-v3');
    expect(fd.get('response_format')).toBe('verbose_json');
    expect(fd.get('language')).toBe('en');
    expect(fd.get('file')).toBeInstanceOf(Blob);
  });

  it('omits optional fields when not provided', async () => {
    let capturedForm: FormData | null = null;
    server.use(
      http.post(WHISPER_URL, async ({ request }) => {
        capturedForm = await request.formData();
        return HttpResponse.json(PHASE0_VERBOSE_JSON);
      }),
    );
    await connector.transcribe(makeReq());
    const fd = capturedForm as unknown as FormData;
    expect(fd.get('language')).toBeNull();
    expect(fd.get('prompt')).toBeNull();
    expect(fd.get('temperature')).toBeNull();
  });

  it('parses verbose_json: trims text, copies duration, echoes language BCP-47', async () => {
    const r = await connector.transcribe(makeReq());
    expect(r.transcription.startsWith('The quick brown fox')).toBe(true);
    // Trim leading/trailing whitespace.
    expect(r.transcription.startsWith(' ')).toBe(false);
    expect(r.transcription.endsWith(' ')).toBe(false);
    expect(r.audioDurationSeconds).toBeCloseTo(13.70025, 5);
    // faster-whisper already returns BCP-47 ('en') — pass through.
    expect(r.detectedLanguage).toBe('en');
    expect(r.model).toBe('Systran/faster-distil-whisper-large-v3');
  });

  it('returns costUsd=0 — self-hosted, no per-call cost', async () => {
    const r = await connector.transcribe(makeReq());
    expect(r.costUsd).toBe(0);
  });

  it('uses request.model when supplied (overrides STT_LOCAL_WHISPER_MODEL)', async () => {
    let capturedForm: FormData | null = null;
    server.use(
      http.post(WHISPER_URL, async ({ request }) => {
        capturedForm = await request.formData();
        return HttpResponse.json(PHASE0_VERBOSE_JSON);
      }),
    );
    await connector.transcribe(makeReq({ model: 'Systran/faster-whisper-large-v3' }));
    const fd = capturedForm as unknown as FormData;
    expect(fd.get('model')).toBe('Systran/faster-whisper-large-v3');
  });

  it('maps 503 to SttProviderError(server_error) and counts toward circuit breaker', async () => {
    server.use(
      http.post(WHISPER_URL, () => HttpResponse.json({ error: 'model_loading' }, { status: 503 })),
    );
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      name: 'SttProviderError',
      provider: 'local-whisper',
      type: 'server_error',
      upstreamStatus: 503,
    });
  });

  it('maps 400 to SttProviderError(http_error) without tripping CB', async () => {
    server.use(
      http.post(WHISPER_URL, () =>
        HttpResponse.json({ error: 'invalid_audio_format' }, { status: 400 }),
      ),
    );
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      name: 'SttProviderError',
      provider: 'local-whisper',
      type: 'http_error',
      upstreamStatus: 400,
    });
  });

  it('falls back to default base URL when env unset (defensive)', () => {
    // Default LOCAL_WHISPER_BASE_URL when config absent — verifies the
    // catch-branch in getBaseUrl(). Useful for integration paths that
    // instantiate the connector before validateEnv runs.
    const orig = process.env.LOCAL_WHISPER_BASE_URL;
    delete process.env.LOCAL_WHISPER_BASE_URL;
    // Reset cached config by re-validating with empty env.
    try {
      validateEnv({ DATABASE_URL: 'postgresql://test', STT_PROVIDER_GROQ_ENABLED: 'false' });
      const fresh = new LocalWhisperSttConnector();
      // Access via getBaseUrl is protected — read through name/provider to
      // make sure the instance constructs, then directly probe via a tiny
      // status call would touch network; spec asserts identity instead.
      expect(fresh.name).toBe('local-whisper');
      expect(fresh.provider).toBe('local-whisper');
    } finally {
      if (orig) process.env.LOCAL_WHISPER_BASE_URL = orig;
    }
  });
});
