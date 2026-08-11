import { z } from 'zod';

export const voiceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    is_owner: z.boolean(),
    is_public: z.boolean(),
    description: z.string().optional(),
    language: z.string(),
    country: z.string().optional(),
    gender: z.enum(['masculine', 'feminine', 'gender_neutral']).optional(),
    created_at: z.string(),
  })
  .passthrough();

export const voiceListSchema = z
  .object({
    data: z.array(voiceSchema),
    has_more: z.boolean(),
    next_page: z.string().nullable().optional(),
  })
  .passthrough();

export const ttsRequestSchema = z.object({
  model_id: z.string().min(1),
  transcript: z.string().min(1),
  voice: z.object({ mode: z.literal('id'), id: z.string().min(1) }).passthrough(),
  output_format: z
    .object({
      container: z.enum(['raw', 'wav', 'mp3']),
      encoding: z.enum(['pcm_f32le', 'pcm_s16le', 'pcm_mulaw', 'pcm_alaw']).optional(),
      sample_rate: z.number().int().positive().optional(),
      bit_rate: z.number().int().positive().optional(),
    })
    .passthrough(),
  language: z.string().optional(),
  pronunciation_dict_id: z.string().optional(),
  generation_config: z
    .object({ volume: z.number().optional(), speed: z.number().optional() })
    .passthrough()
    .optional(),
});

export const providerErrorSchema = z
  .object({
    error_code: z.string(),
    title: z.string(),
    message: z.string(),
    request_id: z.string(),
  })
  .passthrough();

export type CartesiaTtsRequest = z.infer<typeof ttsRequestSchema>;
export type CartesiaVoice = z.infer<typeof voiceSchema>;
