// CONN-0102 — STT envelope shapes.
// Эти types — единственный авторитативный контракт между
// SpeechController/SttRouterService и HTTP-клиентом. Любая правка тут =
// breaking-change для Transcribator+ARCA-Assistant.

import type { SpeechErrorEnvelope } from './speech-response.dto';

export interface SttSuccessResponse {
  transcription: string;
  model: string;
  provider: 'groq'; // Phase 1a — single provider. Phase 1b расширяет union.
  language?: string;
  latency_ms: number;
  cost_usd: number;
  audio_duration_seconds?: number;
  fallback_count: number; // Phase 1a всегда 0; Phase 1b считает cascade hops.
  request_id: string;
}

export type SttResponse = SttSuccessResponse | SpeechErrorEnvelope;

export function isSttSuccess(r: SttResponse): r is SttSuccessResponse {
  return (r as SttSuccessResponse).transcription !== undefined;
}
