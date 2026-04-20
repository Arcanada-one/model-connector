import { z } from 'zod';

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
