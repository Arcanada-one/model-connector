import { Injectable } from '@nestjs/common';
import { BaseSttConnector } from './base-stt.connector';
import { getConfig } from '../../config/env.schema';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

interface DeepgramListenResponse {
  metadata?: { request_id?: string; duration?: number };
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string }>;
    }>;
  };
}

const DEFAULT_DEEPGRAM_BASE_URL = 'https://api.deepgram.com';
const DEFAULT_DEEPGRAM_MODEL = 'nova-3';

/**
 * CONN-0103 — Deepgram nova-3 STT connector.
 *
 * Uses raw-body POST (Content-Type: audio/wav), not multipart. Auth header
 * `Authorization: Token <key>` is Deepgram-specific (different from Bearer).
 * Query string carries the model, language and other knobs.
 */
@Injectable()
export class DeepgramSttConnector extends BaseSttConnector {
  readonly name = 'deepgram-stt';
  readonly provider = 'deepgram';

  protected getBaseUrl(): string {
    return DEFAULT_DEEPGRAM_BASE_URL;
  }

  protected getRequestPath(request: SttConnectorRequest): string {
    const params = new URLSearchParams();
    params.set('model', request.model ?? this.getDefaultModel());
    if (request.language) params.set('language', request.language);
    return `/v1/listen?${params.toString()}`;
  }

  protected getAuthHeader(): Record<string, string> {
    const key = this.resolveApiKey();
    return { Authorization: `Token ${key}` };
  }

  private resolveApiKey(): string {
    try {
      return getConfig().STT_DEEPGRAM_API_KEY ?? process.env.STT_DEEPGRAM_API_KEY ?? '';
    } catch {
      return process.env.STT_DEEPGRAM_API_KEY ?? '';
    }
  }

  protected getDefaultTimeoutMs(): number {
    try {
      return getConfig().STT_DEEPGRAM_TIMEOUT_MS;
    } catch {
      return 60_000;
    }
  }

  protected getMaxConcurrency(): number {
    try {
      return getConfig().STT_DEEPGRAM_MAX_CONCURRENCY;
    } catch {
      return 10;
    }
  }

  protected buildRequestBody(request: SttConnectorRequest): {
    body: BodyInit;
    contentType?: string;
  } {
    const copy = new Uint8Array(request.file.byteLength);
    copy.set(request.file);
    return { body: copy, contentType: request.mimeType };
  }

  protected parseSttResponse(
    json: unknown,
    request: SttConnectorRequest,
  ): {
    transcription: string;
    detectedLanguage?: string;
    audioDurationSeconds?: number;
    model: string;
    providerRequestId?: string;
  } {
    const r = json as DeepgramListenResponse;
    const transcript = r.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return {
      transcription: transcript.trim(),
      detectedLanguage: request.language,
      audioDurationSeconds: r.metadata?.duration,
      model: request.model ?? this.getDefaultModel(),
      providerRequestId: r.metadata?.request_id,
    };
  }

  protected getCostUsd(audioDurationSeconds: number | undefined): number {
    if (audioDurationSeconds === undefined || audioDurationSeconds <= 0) return 0;
    let pricePerMin = 0.0043;
    try {
      pricePerMin = getConfig().STT_DEEPGRAM_PRICE_USD_PER_MIN;
    } catch {
      /* fallback to literal */
    }
    return (audioDurationSeconds / 60) * pricePerMin;
  }

  protected getDefaultModel(): string {
    try {
      return getConfig().STT_DEEPGRAM_MODEL;
    } catch {
      return DEFAULT_DEEPGRAM_MODEL;
    }
  }
}
