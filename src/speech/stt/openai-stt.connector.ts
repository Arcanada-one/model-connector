import { Injectable } from '@nestjs/common';
import { BaseSttConnector } from './base-stt.connector';
import { getConfig } from '../../config/env.schema';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

interface OpenAiTranscriptionResponse {
  text?: string;
  usage?: { input_tokens?: number };
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini-transcribe';

/**
 * CONN-0103 — OpenAI STT connector (`gpt-4o-mini-transcribe`).
 *
 * Live-fixture-driven gotcha: `response_format=verbose_json` is rejected
 * by `gpt-4o-mini-transcribe` and `gpt-4o-transcribe` — we MUST send `json`.
 * `verbose_json` is reserved for `whisper-1` only (not used in CONN-0103).
 *
 * OpenAI does NOT echo `language` or `duration`. We pass the request's
 * `language` through unchanged (or leave `detectedLanguage` undefined).
 * `audioDurationSeconds` is supplied by the caller via fixture capture or
 * estimated from `usage.input_tokens` downstream — connector leaves it
 * undefined here and lets the router fall back to request-time metadata
 * if no value is available.
 */
@Injectable()
export class OpenAiSttConnector extends BaseSttConnector {
  readonly name = 'openai-stt';
  readonly provider = 'openai';

  protected getBaseUrl(): string {
    return DEFAULT_OPENAI_BASE_URL;
  }

  protected getRequestPath(): string {
    return '/v1/audio/transcriptions';
  }

  protected getAuthHeader(): Record<string, string> {
    const key = this.resolveApiKey();
    return { Authorization: `Bearer ${key}` };
  }

  private resolveApiKey(): string {
    try {
      return getConfig().STT_OPENAI_API_KEY ?? process.env.STT_OPENAI_API_KEY ?? '';
    } catch {
      return process.env.STT_OPENAI_API_KEY ?? '';
    }
  }

  protected getDefaultTimeoutMs(): number {
    try {
      return getConfig().STT_OPENAI_TIMEOUT_MS;
    } catch {
      return 60_000;
    }
  }

  protected getMaxConcurrency(): number {
    try {
      return getConfig().STT_OPENAI_MAX_CONCURRENCY;
    } catch {
      return 10;
    }
  }

  protected buildMultipartBody(request: SttConnectorRequest): FormData {
    const fd = new FormData();
    const filename = request.filename ?? this.defaultFilename(request.mimeType);
    const copy = new Uint8Array(request.file.byteLength);
    copy.set(request.file);
    fd.append('file', new Blob([copy], { type: request.mimeType }), filename);
    fd.append('model', request.model ?? this.getDefaultModel());
    // verbose_json rejected by gpt-4o-mini-transcribe — see fixture drift
    // discovery 2026-05-16.
    fd.append('response_format', 'json');
    if (request.language) fd.append('language', request.language);
    if (request.prompt) fd.append('prompt', request.prompt);
    if (request.temperature !== undefined) {
      fd.append('temperature', String(request.temperature));
    }
    return fd;
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
    const r = json as OpenAiTranscriptionResponse;
    return {
      transcription: (r.text ?? '').trim(),
      detectedLanguage: request.language,
      audioDurationSeconds: undefined,
      model: request.model ?? this.getDefaultModel(),
      providerRequestId: undefined,
    };
  }

  protected getCostUsd(audioDurationSeconds: number | undefined): number {
    if (audioDurationSeconds === undefined || audioDurationSeconds <= 0) return 0;
    let pricePerMin = 0.006;
    try {
      pricePerMin = getConfig().STT_OPENAI_PRICE_USD_PER_MIN;
    } catch {
      /* fallback to literal */
    }
    return (audioDurationSeconds / 60) * pricePerMin;
  }

  protected getDefaultModel(): string {
    try {
      return getConfig().STT_OPENAI_MODEL;
    } catch {
      return DEFAULT_OPENAI_MODEL;
    }
  }

  private defaultFilename(mime: string): string {
    const ext = mime.split('/')[1]?.replace('x-', '') ?? 'bin';
    return `audio.${ext}`;
  }
}
