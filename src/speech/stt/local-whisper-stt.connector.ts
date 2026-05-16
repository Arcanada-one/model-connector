import { Injectable } from '@nestjs/common';
import { BaseSttConnector } from './base-stt.connector';
import { getConfig } from '../../config/env.schema';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

/**
 * CONN-0104 — LocalWhisperSttConnector. Self-hosted faster-whisper-server
 * on arcana-ai (CPU-only, Tailscale-only port 8400) speaking the OpenAI
 * /v1/audio/transcriptions compat surface.
 *
 * Per Phase 0 capture (CONN-0101-fixtures.md 2026-05-16):
 *   * Image: fedirz/faster-whisper-server@sha256:760e5e43d…6030
 *   * Model: Systran/faster-distil-whisper-large-v3 (INT8 CT2).
 *   * Response: verbose_json — {task, language, duration, text, words,
 *     segments[...]} with BCP-47 `language` already (no Groq-style label
 *     mapping needed).
 *   * No auth (Tailscale network boundary is the auth gate; AAL T3 in
 *     plan § Security Design).
 *
 * costUsd is constantly 0 — self-hosted, no per-call billing. Daily quota
 * still increments the per-request counter (audit + provider-aggregate
 * cap), but never the cost ledger.
 */
interface FasterWhisperVerboseJson {
  task?: string;
  language?: string;
  duration?: number;
  text?: string;
  // segments + words exist but are not surfaced through SttConnectorResult.
}

const DEFAULT_LOCAL_WHISPER_BASE_URL = 'http://arcana-ai:8400';
const DEFAULT_LOCAL_WHISPER_MODEL = 'Systran/faster-distil-whisper-large-v3';

@Injectable()
export class LocalWhisperSttConnector extends BaseSttConnector {
  readonly name = 'local-whisper';
  readonly provider = 'local-whisper';

  protected getBaseUrl(): string {
    try {
      return getConfig().LOCAL_WHISPER_BASE_URL;
    } catch {
      return process.env.LOCAL_WHISPER_BASE_URL ?? DEFAULT_LOCAL_WHISPER_BASE_URL;
    }
  }

  protected getRequestPath(): string {
    return '/v1/audio/transcriptions';
  }

  protected getAuthHeader(): Record<string, string> {
    // Tailscale-only listener — no Bearer auth. Returning empty leaves the
    // request unauthenticated, which is the correct contract.
    return {};
  }

  protected getDefaultTimeoutMs(): number {
    try {
      return getConfig().STT_LOCAL_WHISPER_TIMEOUT_MS;
    } catch {
      // 5min headroom — Phase 0 measured RTF 1.05× on CPU; ~5min audio max.
      return 300_000;
    }
  }

  protected getMaxConcurrency(): number {
    try {
      return getConfig().STT_LOCAL_WHISPER_MAX_CONCURRENCY;
    } catch {
      // Single-slot per INSIGHTS-CONN-0101 CP-2 + mem_limit=4g headroom.
      return 1;
    }
  }

  protected buildMultipartBody(request: SttConnectorRequest): FormData {
    const fd = new FormData();
    const filename = request.filename ?? this.defaultFilename(request.mimeType);
    // Same Buffer→ArrayBuffer copy idiom as GroqSttConnector — Node 22's
    // Buffer typedef declares ArrayBufferLike, which Blob refuses directly.
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
    const r = json as FasterWhisperVerboseJson;
    return {
      transcription: (r.text ?? '').trim(),
      // faster-whisper-server emits BCP-47 already ('en', 'ru', ...) — no
      // Groq-style natural-language label mapping required.
      detectedLanguage: r.language ?? request.language,
      audioDurationSeconds: r.duration,
      model: request.model ?? this.getDefaultModel(),
      providerRequestId: undefined,
    };
  }

  protected getCostUsd(_audioDurationSeconds: number | undefined): number {
    return 0;
  }

  protected getDefaultModel(): string {
    try {
      return getConfig().STT_LOCAL_WHISPER_MODEL;
    } catch {
      return DEFAULT_LOCAL_WHISPER_MODEL;
    }
  }

  private defaultFilename(mime: string): string {
    const ext = mime.split('/')[1]?.replace('x-', '') ?? 'bin';
    return `audio.${ext}`;
  }
}
