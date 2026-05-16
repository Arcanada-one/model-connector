import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseSttConnector } from './base-stt.connector';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

class TestSttConnector extends BaseSttConnector {
  readonly name = 'test-stt';
  readonly provider = 'test';

  getBaseUrl(): string {
    return 'https://stt.example.test';
  }
  getRequestPath(): string {
    return '/transcribe';
  }
  getAuthHeader(): Record<string, string> {
    return { Authorization: 'Bearer test-key' };
  }
  buildMultipartBody(req: SttConnectorRequest): FormData {
    const fd = new FormData();
    const copy = new Uint8Array(req.file.byteLength);
    copy.set(req.file);
    fd.append('file', new Blob([copy], { type: req.mimeType }), req.filename ?? 'audio.wav');
    return fd;
  }
  parseSttResponse(json: unknown) {
    const j = json as { text: string; duration?: number };
    return {
      transcription: j.text.trim(),
      audioDurationSeconds: j.duration,
      model: 'test-model',
    };
  }
  getCostUsd(_dur: number | undefined): number {
    return 0.001;
  }

  // Expose for spec
  protected getMaxConcurrency(): number {
    return 10;
  }
}

function makeReq(overrides: Partial<SttConnectorRequest> = {}): SttConnectorRequest {
  const buf = Buffer.from([0x00, 0x01, 0x02]);
  return {
    file: buf,
    mimeType: 'audio/wav',
    audioBytes: buf.length,
    requestId: 'req-1',
    ...overrides,
  };
}

describe('BaseSttConnector', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let connector: TestSttConnector;

  beforeEach(() => {
    connector = new TestSttConnector();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns SttConnectorResult on 200 success and records CB success', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: ' hello world ', duration: 1.5 }), { status: 200 }),
    );
    const result = await connector.transcribe(makeReq());
    expect(result.transcription).toBe('hello world');
    expect(result.audioDurationSeconds).toBe(1.5);
    expect(result.model).toBe('test-model');
    expect(result.costUsd).toBe(0.001);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('throws SttProviderError(auth_failed) on 401 and does NOT trip CB', async () => {
    // Use a factory so each call gets a fresh Response (Response.text() consumes
    // the body once — reusing the same instance would mask the assertion).
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 401 }),
    );
    // 6 calls (above default CB threshold=5) — still must not flip CB to open.
    for (let i = 0; i < 6; i++) {
      await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
        type: 'auth_failed',
      });
    }
    fetchSpy.mockImplementationOnce(
      async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
    );
    await expect(connector.transcribe(makeReq())).resolves.toBeDefined();
  });

  it('throws SttProviderError(rate_limited) on 429 and CB counts it', async () => {
    fetchSpy.mockImplementation(async () => new Response('limited', { status: 429 }));
    for (let i = 0; i < 5; i++) {
      await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
        type: 'rate_limited',
      });
    }
    // 6th attempt: CB now open, fast-fail before fetch.
    fetchSpy.mockClear();
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      type: 'server_error',
      message: expect.stringContaining('Circuit breaker open'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws SttProviderError(server_error) on 502 and CB counts it', async () => {
    fetchSpy.mockImplementation(async () => new Response('boom', { status: 502 }));
    for (let i = 0; i < 5; i++) {
      await expect(connector.transcribe(makeReq())).rejects.toMatchObject({ type: 'server_error' });
    }
    fetchSpy.mockClear();
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      message: expect.stringContaining('Circuit breaker open'),
    });
  });

  it('classifies AbortError as timeout', async () => {
    fetchSpy.mockRejectedValue(new DOMException('Request aborted', 'AbortError'));
    await expect(connector.transcribe(makeReq({ timeoutMs: 1_000 }))).rejects.toMatchObject({
      type: 'timeout',
    });
  });

  it('classifies network failure as network_error', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({ type: 'network_error' });
  });

  it('preserves semaphore concurrency cap (12 parallel @ cap=2 → 10 queued)', async () => {
    connector.setSemaphore(2);
    let inFlight = 0;
    let peak = 0;
    fetchSpy.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return new Response(JSON.stringify({ text: 'x', duration: 0.1 }), { status: 200 });
    });
    const tasks = Array.from({ length: 12 }, () => connector.transcribe(makeReq()));
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
