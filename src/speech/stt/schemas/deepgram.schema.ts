import { z } from 'zod';

/**
 * CONN-0103 — Deepgram /v1/listen response schema (nova-3).
 *
 * Captured shape — fixture cell `Deepgram → http_200` in
 * `datarim/tasks/CONN-0101-fixtures.md` (provenance: documented-pending-key
 * 2026-05-16, must be live-reverified before production flip).
 *
 * Strict-mode parsing fields used by `parseSttResponse`:
 *   transcription          ← results.channels[0].alternatives[0].transcript
 *   audioDurationSeconds   ← metadata.duration
 *   providerRequestId      ← metadata.request_id
 *
 * Unknown extra top-level keys are tolerated (`.passthrough()`); only the
 * required nested path is validated. Drift = required path missing / wrong
 * type → cascade triggers next provider per V-AC-4.
 */
export const deepgramListenResponseSchema = z
  .object({
    metadata: z
      .object({
        request_id: z.string().min(1),
        duration: z.number().nonnegative().optional(),
      })
      .passthrough(),
    results: z.object({
      channels: z
        .array(
          z.object({
            alternatives: z
              .array(
                z
                  .object({
                    transcript: z.string(),
                  })
                  .passthrough(),
              )
              .min(1),
          }),
        )
        .min(1),
    }),
  })
  .passthrough();

export type DeepgramListenResponse = z.infer<typeof deepgramListenResponseSchema>;
