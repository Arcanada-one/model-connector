// CONN-0102 — STT envelope shapes.
// Эти types — единственный авторитативный контракт между
// SpeechController/SttRouterService и HTTP-клиентом. Любая правка тут =
// breaking-change для Transcribator+ARCA-Assistant.

import type { SpeechErrorEnvelope } from './speech-response.dto';

// CONN-0103 — provider union widened to cover Phase 1b connectors.
export type SttProvider = 'groq' | 'deepgram' | 'assemblyai' | 'openai';

export interface SttSuccessResponse {
  transcription: string;
  model: string;
  provider: SttProvider;
  language?: string;
  latency_ms: number;
  cost_usd: number;
  audio_duration_seconds?: number;
  fallback_count: number; // count of providers tried before success (0 = first hit)
  request_id: string;
}

export type SttResponse = SttSuccessResponse | SpeechErrorEnvelope;

export function isSttSuccess(r: SttResponse): r is SttSuccessResponse {
  return (r as SttSuccessResponse).transcription !== undefined;
}
