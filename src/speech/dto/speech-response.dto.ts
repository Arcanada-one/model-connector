export type SpeechErrorCode =
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'speech_backend_disabled'
  | 'vad_not_implemented'
  // CONN-0102 — STT routing surface (replaces stt_not_yet_routed stub).
  | 'stt_audio_too_large'
  | 'stt_unsupported_mime'
  | 'stt_validation_error'
  | 'stt_provider_failed'
  | 'stt_all_providers_exhausted'
  | 'stt_no_provider_configured'
  // CONN-0103 — hard daily-cost CB.
  | 'stt_budget_exhausted';

export interface SpeechErrorEnvelope {
  statusCode: number;
  error_code: SpeechErrorCode | string;
  message: string;
  tracking?: string;
  upstream_url?: string;
  /** CONN-0103 — typed payload extras (budget cap details, providers_tried). */
  details?: Record<string, unknown>;
}
