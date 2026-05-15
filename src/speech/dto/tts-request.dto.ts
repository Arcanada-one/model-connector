import { z } from 'zod';

export const TTS_MAX_TEXT_CHARS = 5_000;
export const TTS_SPEAKERS = ['xenia', 'aidar', 'baya', 'kseniya', 'eugene'] as const;
export const TTS_SAMPLE_RATES = [8_000, 24_000, 48_000] as const;

export const ttsRequestSchema = z
  .object({
    text: z.string().min(1).max(TTS_MAX_TEXT_CHARS),
    speaker: z.enum(TTS_SPEAKERS).default('xenia'),
    sample_rate: z.union([z.literal(8_000), z.literal(24_000), z.literal(48_000)]).default(24_000),
    speed: z.number().min(0.5).max(2.0).default(1.0),
  })
  .strict();

export type TtsRequestDto = z.infer<typeof ttsRequestSchema>;
