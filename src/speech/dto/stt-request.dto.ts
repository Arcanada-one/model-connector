import { z } from 'zod';

// Whisper-family providers (Groq, OpenAI) accept this set of input MIME types.
export const STT_ALLOWED_MIME_TYPES = [
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg', // mp3
  'audio/mp3',
  'audio/mp4', // m4a, mp4 audio
  'audio/x-m4a',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
] as const;

export type SttAllowedMime = (typeof STT_ALLOWED_MIME_TYPES)[number];

export const STT_PROMPT_MAX_CHARS = 1024;
export const STT_TEMPERATURE_MIN = 0;
export const STT_TEMPERATURE_MAX = 1;

// BCP-47 language tag — narrow check: 2-letter (en) или 5-char (en-US).
// Не валидируем по реестру IANA — Whisper сам отбрасывает unknown коды.
const bcp47Tag = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'language must be BCP-47 tag like "en" or "en-US"');

// MIME — допускаем prefix-сопоставление через .refine для robustness:
// browser-multipart часто шлёт `audio/mp4;codecs=mp4a.40.2` — отрезаем suffix.
const mimeField = z
  .string()
  .min(1)
  .transform((s) => s.split(';')[0].trim().toLowerCase())
  .refine((s): s is SttAllowedMime => (STT_ALLOWED_MIME_TYPES as readonly string[]).includes(s), {
    message: `mimeType must be one of: ${STT_ALLOWED_MIME_TYPES.join(', ')}`,
  });

// Note: `file` validation выполняется на уровне controller (audio-size + Buffer
// presence) — multipart parser даёт Buffer, его проверяет SttAudioTooLargeError.
// В schema держим только структурные поля (то, что приходит как form-field).
export const sttRequestSchema = z
  .object({
    mimeType: mimeField,
    filename: z.string().min(1).max(255).optional(),
    language: bcp47Tag.optional(),
    model: z.string().min(1).max(64).optional(),
    prompt: z.string().max(STT_PROMPT_MAX_CHARS).optional(),
    temperature: z.coerce.number().min(STT_TEMPERATURE_MIN).max(STT_TEMPERATURE_MAX).optional(),
    requestId: z.string().min(1).max(128).optional(),
    timeoutMs: z.coerce.number().int().min(1_000).max(300_000).optional(),
  })
  .strict();

export type SttRequestDto = z.infer<typeof sttRequestSchema>;
