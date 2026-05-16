import { Injectable } from '@nestjs/common';
import { BaseSttConnector } from './base-stt.connector';
import { getConfig } from '../../config/env.schema';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

interface GroqWhisperResponse {
  task?: string;
  language?: string;
  duration?: number;
  text: string;
  x_groq?: { id?: string };
}

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3';

@Injectable()
export class GroqSttConnector extends BaseSttConnector {
  readonly name = 'groq-stt';
  readonly provider = 'groq';

  protected getBaseUrl(): string {
    return DEFAULT_GROQ_BASE_URL;
  }

  protected getRequestPath(): string {
    return '/openai/v1/audio/transcriptions';
  }

  protected getAuthHeader(): Record<string, string> {
    // STT_GROQ_API_KEY is the canonical slot; fall back to legacy GROQ_API_KEY
    // (chat surface) — both point at the same Groq account in Phase 1a.
    let key = '';
    try {
      const config = getConfig();
      key = config.STT_GROQ_API_KEY ?? process.env.GROQ_API_KEY ?? '';
    } catch {
      key = process.env.STT_GROQ_API_KEY ?? process.env.GROQ_API_KEY ?? '';
    }
    return { Authorization: `Bearer ${key}` };
  }

  protected getDefaultTimeoutMs(): number {
    try {
      return getConfig().STT_GROQ_TIMEOUT_MS;
    } catch {
      return 60_000;
    }
  }

  protected getMaxConcurrency(): number {
    try {
      return getConfig().STT_GROQ_MAX_CONCURRENCY;
    } catch {
      return 10;
    }
  }

  protected buildMultipartBody(request: SttConnectorRequest): FormData {
    const fd = new FormData();
    const filename = request.filename ?? this.defaultFilename(request.mimeType);
    // Buffer is a Uint8Array view. We copy bytes into a fresh ArrayBuffer-
    // backed Uint8Array so TS sees an unambiguous BlobPart (Node 22's Buffer
    // typedef declares ArrayBufferLike, which Blob refuses).
    const copy = new Uint8Array(request.file.byteLength);
    copy.set(request.file);
    fd.append('file', new Blob([copy], { type: request.mimeType }), filename);
    fd.append('model', request.model ?? this.getDefaultModel());
    fd.append('response_format', 'verbose_json');
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
    const r = json as GroqWhisperResponse;
    return {
      transcription: (r.text ?? '').trim(),
      detectedLanguage: this.normaliseLanguage(r.language, request.language),
      audioDurationSeconds: r.duration,
      model: request.model ?? this.getDefaultModel(),
      providerRequestId: r.x_groq?.id,
    };
  }

  protected getCostUsd(audioDurationSeconds: number | undefined): number {
    if (audioDurationSeconds === undefined || audioDurationSeconds <= 0) return 0;
    let pricePerMin = 0.00185;
    try {
      pricePerMin = getConfig().STT_GROQ_PRICE_USD_PER_MIN;
    } catch {
      /* fallback to literal */
    }
    return (audioDurationSeconds / 60) * pricePerMin;
  }

  protected getDefaultModel(): string {
    try {
      return getConfig().STT_GROQ_MODEL;
    } catch {
      return DEFAULT_GROQ_MODEL;
    }
  }

  /** Groq returns `language` как natural-language label ("English"). Если
   * клиент явно прислал BCP-47 (`en`) — отдаём его обратно; иначе пробуем
   * map; иначе lowercase label (downstream consumers сами решают). */
  private normaliseLanguage(
    providerLabel: string | undefined,
    requestLang: string | undefined,
  ): string | undefined {
    if (requestLang) return requestLang;
    if (!providerLabel) return undefined;
    const lower = providerLabel.toLowerCase();
    const map: Record<string, string> = {
      english: 'en',
      russian: 'ru',
      spanish: 'es',
      french: 'fr',
      german: 'de',
      italian: 'it',
      portuguese: 'pt',
      chinese: 'zh',
      japanese: 'ja',
      korean: 'ko',
      ukrainian: 'uk',
    };
    return map[lower] ?? lower;
  }

  private defaultFilename(mime: string): string {
    const ext = mime.split('/')[1]?.replace('x-', '') ?? 'bin';
    return `audio.${ext}`;
  }
}
