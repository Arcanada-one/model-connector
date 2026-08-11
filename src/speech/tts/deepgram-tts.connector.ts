import { Injectable } from '@nestjs/common';
import { getConfig } from '../../config/env.schema';
import type { ProxyContext, ProxyResult } from '../transcribator.proxy';
import { getDeepgramAuraMetadata, type DeepgramAuraModelId } from './deepgram-aura-models';

export type DeepgramTtsErrorCode =
  | 'provider_disabled'
  | 'upstream_rate_limited'
  | 'upstream_authentication_failed'
  | 'upstream_timeout'
  | 'upstream_unavailable';

export class DeepgramTtsError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: DeepgramTtsErrorCode,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'DeepgramTtsError';
  }
}

const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'retry-after',
  'x-request-id',
]);

@Injectable()
export class DeepgramTtsConnector {
  async synthesize(
    modelId: DeepgramAuraModelId,
    text: string,
    ctx: ProxyContext,
  ): Promise<ProxyResult> {
    const config = getConfig();
    if (!config.TTS_PROVIDER_DEEPGRAM_ENABLED) {
      throw new DeepgramTtsError(503, 'provider_disabled', 'Deepgram TTS provider is disabled.');
    }
    if (!config.TTS_DEEPGRAM_API_KEY) {
      throw new DeepgramTtsError(
        502,
        'upstream_authentication_failed',
        'Deepgram TTS authentication is unavailable.',
      );
    }
    const metadata = getDeepgramAuraMetadata(modelId);

    const url = new URL('/v1/speak', config.TTS_DEEPGRAM_BASE_URL);
    url.searchParams.set('model', metadata.model);
    url.searchParams.set('encoding', metadata.output.encoding);
    url.searchParams.set('container', metadata.output.container);
    url.searchParams.set('sample_rate', String(metadata.output.sampleRate));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${config.TTS_DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Request-ID': ctx.requestId,
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(config.TTS_DEEPGRAM_TIMEOUT_MS),
      });
      if (!response.ok) {
        await this.discardBody(response);
        throw this.fromUpstreamStatus(response.status);
      }
      return this.toResult(response);
    } catch (error) {
      if (error instanceof DeepgramTtsError) throw error;
      if (
        error instanceof DOMException &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new DeepgramTtsError(504, 'upstream_timeout', 'Deepgram TTS request timed out.');
      }
      throw new DeepgramTtsError(
        502,
        'upstream_unavailable',
        'Deepgram TTS provider is unavailable.',
      );
    }
  }

  private fromUpstreamStatus(status: number): DeepgramTtsError {
    if (status === 429) {
      return new DeepgramTtsError(
        429,
        'upstream_rate_limited',
        'Deepgram TTS rate limit reached.',
        status,
      );
    }
    if (status === 401 || status === 403) {
      return new DeepgramTtsError(
        502,
        'upstream_authentication_failed',
        'Deepgram TTS authentication failed.',
        status,
      );
    }
    return new DeepgramTtsError(
      502,
      'upstream_unavailable',
      'Deepgram TTS provider is unavailable.',
      status,
    );
  }

  private async toResult(response: Response): Promise<ProxyResult> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('audio/')) {
      await this.discardBody(response);
      throw new DeepgramTtsError(
        502,
        'upstream_unavailable',
        'Deepgram TTS provider returned an invalid response.',
        response.status,
      );
    }
    const body = await response.arrayBuffer();
    if (body.byteLength === 0) {
      throw new DeepgramTtsError(
        502,
        'upstream_unavailable',
        'Deepgram TTS provider returned an empty response.',
        response.status,
      );
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (FORWARDED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        headers[key.toLowerCase()] = value;
      }
    });
    return {
      status: response.status,
      headers,
      body,
      contentType,
    };
  }

  private async discardBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // Best effort only; provider details are intentionally never read or logged.
    }
  }
}
