import { buildDeepgramSpeakUrl, deepgramAuthorization } from './deepgram-tts.url';
import type { DeepgramTtsHttpResult, DeepgramTtsRequest } from './deepgram-tts.types';

interface HttpDependencies {
  fetch: typeof globalThis.fetch;
}

export class DeepgramTtsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly code?: string,
  ) {
    super(`Deepgram Aura HTTP ${status}${code ? ` (${code})` : ''}: ${body}`);
    this.name = 'DeepgramTtsHttpError';
  }
}

export class DeepgramAuraHttpClient {
  constructor(private readonly dependencies: HttpDependencies = { fetch: globalThis.fetch }) {}

  async synthesize(request: DeepgramTtsRequest): Promise<DeepgramTtsHttpResult> {
    if (!request.text.trim()) throw new TypeError('Deepgram Aura text is required');
    const response = await this.dependencies.fetch(buildDeepgramSpeakUrl(request, 'http'), {
      method: 'POST',
      headers: {
        Authorization: deepgramAuthorization(request.auth),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: request.text }),
    });
    if (!response.ok) {
      const body = await response.text();
      let code: string | undefined;
      try {
        const parsed = JSON.parse(body) as { err_code?: unknown };
        if (typeof parsed.err_code === 'string') code = parsed.err_code;
      } catch {
        // Deepgram may return plain text for proxy or gateway errors.
      }
      throw new DeepgramTtsHttpError(response.status, body, code);
    }
    return {
      audio: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? undefined,
      requestId: response.headers.get('dg-request-id') ?? undefined,
    };
  }
}
