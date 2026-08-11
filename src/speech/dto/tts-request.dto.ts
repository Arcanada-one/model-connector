import { z } from 'zod';
import { DEEPGRAM_AURA_MODEL_IDS } from '../tts/deepgram-aura-models';
import {
  TOGETHER_ORPHEUS_MODEL_ID,
  TOGETHER_ORPHEUS_VOICES,
} from '../tts/together-orpheus.metadata';
import { TOGETHER_CARTESIA_SONIC_2_MODEL_ID } from '../tts/together-cartesia-sonic-2.metadata';

export const TTS_MAX_TEXT_CHARS = 5_000;
export const DEEPGRAM_TTS_MAX_TEXT_CHARS = 2_000;
export const TTS_SPEAKERS = ['xenia', 'aidar', 'baya', 'kseniya', 'eugene'] as const;
export const TTS_SAMPLE_RATES = [8_000, 24_000, 48_000] as const;

export const legacyTtsRequestSchema = z
  .object({
    text: z.string().min(1).max(TTS_MAX_TEXT_CHARS),
    speaker: z.enum(TTS_SPEAKERS).default('xenia'),
    sample_rate: z.union([z.literal(8_000), z.literal(24_000), z.literal(48_000)]).default(24_000),
    speed: z.number().min(0.5).max(2.0).default(1.0),
  })
  .strict();

export const deepgramTtsRequestSchema = z
  .object({
    provider: z.literal('deepgram'),
    model: z.enum(DEEPGRAM_AURA_MODEL_IDS),
    text: z.string().min(1).max(DEEPGRAM_TTS_MAX_TEXT_CHARS),
  })
  .strict();

export const togetherOrpheusTtsRequestSchema = z
  .object({
    provider: z.literal('together'),
    model: z.literal(TOGETHER_ORPHEUS_MODEL_ID),
    text: z.string().min(1).max(TTS_MAX_TEXT_CHARS),
    voice: z.enum(TOGETHER_ORPHEUS_VOICES),
  })
  .strict();

export const togetherCartesiaTtsRequestSchema = z
  .object({
    provider: z.literal('together'),
    model: z.literal(TOGETHER_CARTESIA_SONIC_2_MODEL_ID),
    text: z.string().min(1).max(TTS_MAX_TEXT_CHARS),
    voice: z.string().uuid(),
  })
  .strict();

export const togetherTtsRequestSchema = z.union([
  togetherOrpheusTtsRequestSchema,
  togetherCartesiaTtsRequestSchema,
]);

export const ttsRequestSchema = z.union([
  deepgramTtsRequestSchema,
  togetherTtsRequestSchema,
  legacyTtsRequestSchema,
]);

export type DeepgramTtsRequestDto = z.infer<typeof deepgramTtsRequestSchema>;
export type TtsRequestDto = z.infer<typeof ttsRequestSchema>;

export function isDeepgramTtsRequest(body: TtsRequestDto): body is DeepgramTtsRequestDto {
  return 'provider' in body && body.provider === 'deepgram';
}

export type TogetherOrpheusTtsRequestDto = z.infer<typeof togetherOrpheusTtsRequestSchema>;
export type TogetherCartesiaTtsRequestDto = z.infer<typeof togetherCartesiaTtsRequestSchema>;
export type TogetherTtsRequestDto = z.infer<typeof togetherTtsRequestSchema>;

export function isTogetherOrpheusTtsRequest(
  body: TtsRequestDto,
): body is TogetherOrpheusTtsRequestDto {
  return (
    'provider' in body && body.provider === 'together' && body.model === TOGETHER_ORPHEUS_MODEL_ID
  );
}

export function isTogetherTtsRequest(body: TtsRequestDto): body is TogetherTtsRequestDto {
  return 'provider' in body && body.provider === 'together';
}
