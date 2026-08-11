import { Injectable } from '@nestjs/common';
import { getConfig } from '../../config/env.schema';
import type { TogetherTtsRequestDto } from '../dto/tts-request.dto';
import type { ProxyContext, ProxyResult } from '../transcribator.proxy';
import { TOGETHER_TTS_MODEL_DEFINITIONS } from './together-tts.model-definitions';

export type TogetherTtsErrorCode =
  | 'provider_disabled'
  | 'upstream_rate_limited'
  | 'upstream_authentication_failed'
  | 'upstream_timeout'
  | 'upstream_unavailable';

export class TogetherTtsError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: TogetherTtsErrorCode,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'TogetherTtsError';
  }
}

const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'retry-after',
  'x-request-id',
]);

@Injectable()
export class TogetherTtsConnector {
  async synthesize(request: TogetherTtsRequestDto, ctx: ProxyContext): Promise<ProxyResult> {
    const config = getConfig();
    if (!config.TTS_PROVIDER_TOGETHER_ENABLED) {
      throw new TogetherTtsError(503, 'provider_disabled', 'Together TTS provider is disabled.');
    }
    if (!config.TOGETHER_API_KEY) {
      throw new TogetherTtsError(
        502,
        'upstream_authentication_failed',
        'Together TTS authentication is unavailable.',
      );
    }

    const definition = TOGETHER_TTS_MODEL_DEFINITIONS[request.model];
    const url = new URL('/v1/audio/speech', config.TOGETHER_BASE_URL);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.TOGETHER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Request-ID': ctx.requestId,
        },
        body: JSON.stringify({
          model: definition.model,
          input: request.text,
          voice: request.voice,
          response_format: 'wav',
        }),
        signal: AbortSignal.timeout(config.TTS_TOGETHER_TIMEOUT_MS),
      });
      if (!response.ok) {
        await this.discardBody(response);
        throw this.fromUpstreamStatus(response.status);
      }
      return await this.toResult(response);
    } catch (error) {
      if (error instanceof TogetherTtsError) throw error;
      throw this.fromFetchFailure(error);
    }
  }

  private fromFetchFailure(error: unknown): TogetherTtsError {
    if (
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      return new TogetherTtsError(504, 'upstream_timeout', 'Together TTS request timed out.');
    }
    return new TogetherTtsError(
      502,
      'upstream_unavailable',
      'Together TTS provider is unavailable.',
    );
  }

  private fromUpstreamStatus(status: number): TogetherTtsError {
    if (status === 429) {
      return new TogetherTtsError(
        429,
        'upstream_rate_limited',
        'Together TTS rate limit reached.',
        status,
      );
    }
    if (status === 401 || status === 403) {
      return new TogetherTtsError(
        502,
        'upstream_authentication_failed',
        'Together TTS authentication failed.',
        status,
      );
    }
    return new TogetherTtsError(
      502,
      'upstream_unavailable',
      'Together TTS provider is unavailable.',
      status,
    );
  }

  private async toResult(response: Response): Promise<ProxyResult> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('audio/')) {
      await this.discardBody(response);
      throw new TogetherTtsError(
        502,
        'upstream_unavailable',
        'Together TTS provider returned an invalid response.',
        response.status,
      );
    }
    const body = await response.arrayBuffer();
    if (body.byteLength === 0) {
      throw new TogetherTtsError(
        502,
        'upstream_unavailable',
        'Together TTS provider returned an empty response.',
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
