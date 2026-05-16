import { z } from 'zod';

/**
 * CONN-0103 — OpenAI /v1/audio/transcriptions response schema
 * (`gpt-4o-mini-transcribe` model, `response_format=json`).
 *
 * Live-captured shape — fixture cell `OpenAI → http_200` 2026-05-16:
 * `verbose_json` REJECTED for this model (HTTP 400); MUST use `json`.
 * `gpt-4o-mini-transcribe` does NOT echo `language` or `duration` —
 * those fields are absent. Connector derives `audioDurationSeconds`
 * client-side (estimated from request audio bytes when needed).
 *
 * Mapped fields:
 *   transcription          ← text
 *   detectedLanguage       — not provided; falls back to request.language
 *   audioDurationSeconds   — derived client-side, not from response
 *   providerRequestId      — absent (only `x-request-id` header)
 *
 * Strict shape: `text` required string (empty allowed — drift flag fires
 * elsewhere when usage.input_tokens > 0 but text === "").
 */
export const openAiTranscriptionResponseSchema = z
  .object({
    text: z.string(),
    usage: z
      .object({
        input_tokens: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type OpenAiTranscriptionResponse = z.infer<typeof openAiTranscriptionResponseSchema>;
