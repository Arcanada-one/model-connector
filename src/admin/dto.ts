import { z } from 'zod';

export const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  rateLimit: z.number().int().min(1).max(10000).optional(),
});

export type CreateKeyDto = z.infer<typeof CreateKeySchema>;

export const ResetCircuitBreakerSchema = z.object({
  connector: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
});

export type ResetCircuitBreakerDto = z.infer<typeof ResetCircuitBreakerSchema>;
