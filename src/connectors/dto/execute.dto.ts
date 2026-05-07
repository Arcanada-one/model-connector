import { z } from 'zod';

// ─── Text connector DTO (existing) ────────────────────────────────────────────

export const executeRequestSchema = z.object({
  connector: z.string().min(1).max(50),
  prompt: z.string().min(1).max(100_000),
  model: z.string().max(100).optional(),
  systemPrompt: z.string().max(100_000).optional(),
  tools: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  maxBudgetUsd: z.number().min(0).max(100).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  responseFormat: z.object({ type: z.enum(['json_object', 'text']) }).optional(),
  timeout: z.number().int().min(5_000).max(600_000).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type ExecuteRequestDto = z.infer<typeof executeRequestSchema>;

export const perConnectorExecuteSchema = executeRequestSchema.omit({ connector: true });
export type PerConnectorExecuteDto = z.infer<typeof perConnectorExecuteSchema>;

// ─── Image generation DTO ─────────────────────────────────────────────────────

export const imageGenerateRequestSchema = z.object({
  tier: z.enum(['cheap', 'mid', 'premium']).default('mid'),
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  aspectRatio: z
    .enum(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', '2:3', '3:2', '5:4', '4:5'])
    .optional(),
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  count: z.number().int().min(1).max(4).default(1),
  seed: z.number().int().optional(),
  outputFormat: z.enum(['url', 'inline_base64']).default('url'),
  outputAsync: z.enum(['auto', 'force', 'never']).default('auto'),
  maxBudgetUsd: z.number().min(0).max(100).optional(),
  model: z.string().max(100).optional(),
});

export type ImageGenerateRequestDto = z.infer<typeof imageGenerateRequestSchema>;
