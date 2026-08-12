export type SpeechErrorCode =
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'speech_backend_disabled'
  | 'vad_not_implemented'
  | 'stt_audio_too_large'
  | 'stt_unsupported_mime'
  | 'stt_validation_error'
  | 'stt_provider_failed'
  | 'stt_all_providers_exhausted'
  | 'stt_no_provider_configured'
  // CONN-0103 — hard daily-cost CB.
  | 'stt_budget_exhausted'
  // CONN-1671 — per-key access policy denied every candidate STT provider (403).
  | 'stt_policy_violation'
  // CONN-1671 — stored policy failed validation; fail-closed deny (403).
  | 'stt_policy_config_error'
  // CONN-1671 — per-key access policy denied the requested TTS provider (403).
  | 'tts_policy_violation';

export interface SpeechErrorEnvelope {
  statusCode: number;
  error_code: SpeechErrorCode | string;
  message: string;
  tracking?: string;
  upstream_url?: string;
  /** CONN-0103 — typed payload extras (budget cap details, providers_tried). */
  details?: Record<string, unknown>;
}
