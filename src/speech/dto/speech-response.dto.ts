export type SpeechErrorCode =
  | 'stt_not_yet_routed'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'speech_backend_disabled'
  | 'vad_not_implemented';

export interface SpeechErrorEnvelope {
  statusCode: number;
  error_code: SpeechErrorCode | string;
  message: string;
  tracking?: string;
  upstream_url?: string;
}

export const STT_STUB_RESPONSE: SpeechErrorEnvelope = {
  statusCode: 501,
  error_code: 'stt_not_yet_routed',
  message:
    'STT routing pending TRANS-0037 (Pilot 1: Transcribator Bot rewire). Direct-Groq vs upstream-Transcribator routing decision deferred to pilot.',
  tracking: 'TRANS-0037',
};
