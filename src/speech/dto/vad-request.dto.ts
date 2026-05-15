import { z } from 'zod';

export const VAD_MAX_AUDIO_BASE64_CHARS = 35_000_000;
export const VAD_SAMPLE_RATES = [8_000, 16_000] as const;

export const vadRequestSchema = z
  .object({
    audio_base64: z
      .string()
      .min(4)
      .max(VAD_MAX_AUDIO_BASE64_CHARS)
      .regex(/^[A-Za-z0-9+/=\s]+$/, 'audio_base64 must be valid base64'),
    sample_rate: z.union([z.literal(8_000), z.literal(16_000)]).default(16_000),
  })
  .strict();

export type VadRequestDto = z.infer<typeof vadRequestSchema>;
