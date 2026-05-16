import { z } from 'zod';

/**
 * CONN-0103 — AssemblyAI /v2/transcript polled-completion response schema.
 *
 * Captured shape — fixture cell `AssemblyAI → http_200` (provenance:
 * documented-pending-key 2026-05-16). Polling layer in
 * `AssemblyAiSttConnector` waits until `status === 'completed'` and feeds
 * that envelope into this schema.
 *
 * Mapped fields:
 *   transcription          ← text
 *   audioDurationSeconds   ← audio_duration
 *   detectedLanguage       ← language_code
 *   providerRequestId      ← id
 */
export const assemblyAiTranscriptResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal('completed'),
    text: z.string(),
    audio_duration: z.number().nonnegative().optional(),
    language_code: z.string().optional(),
  })
  .passthrough();

export type AssemblyAiTranscriptResponse = z.infer<typeof assemblyAiTranscriptResponseSchema>;

/**
 * AssemblyAI /v2/upload response (Step 1 of two-step pipeline).
 * Schema kept tight — connector consumes `upload_url` only.
 */
export const assemblyAiUploadResponseSchema = z
  .object({
    upload_url: z.string().url(),
  })
  .passthrough();

export type AssemblyAiUploadResponse = z.infer<typeof assemblyAiUploadResponseSchema>;
