import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssemblyAiSttConnector } from './assemblyai-stt.connector';
import { validateEnv } from '../../config/env.schema';
import { SttProviderError } from './stt-pilot.errors';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

function makeReq(overrides: Partial<SttConnectorRequest> = {}): SttConnectorRequest {
  const buf = Buffer.from('RIFFWAVEfmt placeholder');
  return {
    file: buf,
    filename: 'audio.wav',
    mimeType: 'audio/wav',
    audioBytes: buf.length,
    requestId: 'req-aai-spec-1',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AssemblyAiSttConnector', () => {
  let connector: AssemblyAiSttConnector;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_GROQ_API_KEY: 'gsk_test_groq_key',
      STT_ASSEMBLYAI_API_KEY: 'aai_test_key',
      STT_ASSEMBLYAI_MODEL: 'universal-2',
      STT_ASSEMBLYAI_PRICE_USD_PER_MIN: '0.0045',
      STT_ASSEMBLYAI_TIMEOUT_MS: '10000',
      STT_ASSEMBLYAI_POLL_INTERVAL_MS: '250',
    });
    connector = new AssemblyAiSttConnector();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two-step pipeline: uploads, submits, polls until completed', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ upload_url: 'https://cdn.assemblyai.com/upload/x' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'tx-123', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'tx-123', status: 'processing' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'tx-123',
          status: 'completed',
          text: 'aai live capture',
          audio_duration: 13,
          language_code: 'en',
        }),
      );
    const result = await connector.transcribe(makeReq());
    expect(result.transcription).toBe('aai live capture');
    expect(result.detectedLanguage).toBe('en');
    expect(result.audioDurationSeconds).toBe(13);
    expect(result.providerRequestId).toBe('tx-123');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    // Verify upload step:
    const [, uploadInit] = fetchSpy.mock.calls[0];
    expect((uploadInit as RequestInit).method).toBe('POST');
    expect((uploadInit as RequestInit).headers).toMatchObject({
      Authorization: 'aai_test_key', // NO Bearer prefix
      'Content-Type': 'audio/wav',
    });
    // Verify submit step:
    const [, submitInit] = fetchSpy.mock.calls[1];
    const submitBody = JSON.parse((submitInit as RequestInit).body as string);
    expect(submitBody.audio_url).toBe('https://cdn.assemblyai.com/upload/x');
    expect(submitBody.speech_model).toBe('universal-2');
  });

  it('upload step 401 → SttProviderError(auth_failed)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Invalid API key', { status: 401 }));
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      name: 'SttProviderError',
      type: 'auth_failed',
    });
  });

  it('polling sees status=error → SttProviderError(server_error)', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ upload_url: 'https://cdn.assemblyai.com/upload/x' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'tx-err', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'tx-err', status: 'error', error: 'transcription failure' }),
      );
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      type: 'server_error',
    });
  });

  it('missing upload_url in step 1 response → parse_error', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    await expect(connector.transcribe(makeReq())).rejects.toBeInstanceOf(SttProviderError);
  });

  it('computes cost from audio_duration', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ upload_url: 'https://cdn.assemblyai.com/upload/y' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'tx-cost', status: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'tx-cost', status: 'completed', text: 't', audio_duration: 120 }),
      );
    const result = await connector.transcribe(makeReq());
    // 120s → 2 min × $0.0045 = $0.009
    expect(result.costUsd).toBeCloseTo(0.009);
  });
});
