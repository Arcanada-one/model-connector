import { Injectable, Logger } from '@nestjs/common';
import { validateEnv } from '../config/env.schema';

export type SpeechEndpoint = 'tts' | 'vad';

export interface ProxyContext {
  requestId: string;
  acceptHeader?: string;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
  contentType: string;
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'retry-after',
  'x-speech-backend',
  'x-speech-model-version',
  'x-request-id',
]);

@Injectable()
export class TranscribatorProxy {
  private readonly logger = new Logger(TranscribatorProxy.name);

  async proxy(
    endpoint: SpeechEndpoint,
    body: Record<string, unknown>,
    ctx: ProxyContext,
  ): Promise<ProxyResult> {
    const config = validateEnv(process.env);
    const url = `${config.TRANSCRIBATOR_API_URL.replace(/\/$/, '')}/v1/speech/${endpoint}`;
    const timeoutMs = config.SPEECH_PROXY_TIMEOUT_MS;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-ID': ctx.requestId,
    };
    if (config.SPEECH_INTERNAL_TOKEN) {
      headers['Authorization'] = `Bearer ${config.SPEECH_INTERNAL_TOKEN}`;
    }
    if (ctx.acceptHeader) {
      headers['Accept'] = ctx.acceptHeader;
    }

    let lastStatus = 502;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await this.sleep(250 + attempt * 500);
      }
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const status = response.status;
        if (RETRYABLE_STATUSES.has(status)) {
          lastStatus = status;
          if (attempt === 0) {
            this.logger.warn(`upstream ${status} on ${url}, will retry`);
            continue;
          }
          throw new UpstreamUnavailableError(url, status);
        }
        return await this.toResult(response);
      } catch (err) {
        if (err instanceof UpstreamUnavailableError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
        if (isTimeout) {
          throw new UpstreamTimeoutError(url, timeoutMs);
        }
        if (attempt === 0) {
          this.logger.warn(`network error on ${url}: ${message}, will retry`);
          continue;
        }
        throw new UpstreamNetworkError(url, message);
      }
    }
    throw new UpstreamUnavailableError(url, lastStatus);
  }

  private async toResult(response: Response): Promise<ProxyResult> {
    const body = await response.arrayBuffer();
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
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class UpstreamTimeoutError extends Error {
  readonly statusCode = 504;
  readonly errorCode = 'upstream_timeout';
  constructor(
    public readonly upstreamUrl: string,
    public readonly timeoutMs: number,
  ) {
    super(`Transcribator API did not respond within ${timeoutMs}ms.`);
  }
}

export class UpstreamUnavailableError extends Error {
  readonly statusCode = 502;
  readonly errorCode = 'upstream_unavailable';
  constructor(
    public readonly upstreamUrl: string,
    public readonly upstreamStatus: number,
  ) {
    super(`Transcribator API returned ${upstreamStatus} after 1 retry.`);
  }
}

export class UpstreamNetworkError extends Error {
  readonly statusCode = 502;
  readonly errorCode = 'upstream_unavailable';
  constructor(
    public readonly upstreamUrl: string,
    public readonly cause: string,
  ) {
    super(`Transcribator API unreachable: ${cause}`);
  }
}
