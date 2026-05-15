import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  TranscribatorProxy,
  ProxyResult,
  SpeechEndpoint,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
  UpstreamNetworkError,
} from './transcribator.proxy';
import { TtsRequestDto } from './dto/tts-request.dto';
import { VadRequestDto } from './dto/vad-request.dto';
import { STT_STUB_RESPONSE, SpeechErrorEnvelope } from './dto/speech-response.dto';

export type ProxyOutcome =
  | { kind: 'proxied'; result: ProxyResult }
  | { kind: 'error'; envelope: SpeechErrorEnvelope };

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  constructor(private readonly proxy: TranscribatorProxy) {}

  async tts(body: TtsRequestDto, requestId?: string): Promise<ProxyOutcome> {
    return this.proxyOrError('tts', body as unknown as Record<string, unknown>, requestId);
  }

  async vad(body: VadRequestDto, requestId?: string): Promise<ProxyOutcome> {
    return this.proxyOrError('vad', body as unknown as Record<string, unknown>, requestId);
  }

  stt(): SpeechErrorEnvelope {
    return STT_STUB_RESPONSE;
  }

  private async proxyOrError(
    endpoint: SpeechEndpoint,
    body: Record<string, unknown>,
    requestId?: string,
  ): Promise<ProxyOutcome> {
    const id = requestId ?? randomUUID();
    try {
      const result = await this.proxy.proxy(endpoint, body, { requestId: id });
      return { kind: 'proxied', result };
    } catch (err) {
      const envelope = this.mapErrorToEnvelope(err);
      this.logger.warn(
        `speech ${endpoint} proxy error: ${envelope.error_code} (${envelope.message})`,
      );
      return { kind: 'error', envelope };
    }
  }

  private mapErrorToEnvelope(err: unknown): SpeechErrorEnvelope {
    if (err instanceof UpstreamTimeoutError) {
      return {
        statusCode: err.statusCode,
        error_code: err.errorCode,
        message: err.message,
        upstream_url: err.upstreamUrl,
      };
    }
    if (err instanceof UpstreamUnavailableError || err instanceof UpstreamNetworkError) {
      return {
        statusCode: err.statusCode,
        error_code: err.errorCode,
        message: err.message,
        upstream_url: err.upstreamUrl,
      };
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    return {
      statusCode: 502,
      error_code: 'upstream_unavailable',
      message: `Speech proxy unexpected failure: ${message}`,
    };
  }
}
