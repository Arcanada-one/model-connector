import { z } from 'zod';
// CONN-1665 — per-key access policy shape (single source of truth).
import { apiKeyPolicySchema } from '../policy/policy.schema';

export const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  rateLimit: z.number().int().min(1).max(10000).optional(),
  // CONN-1665 — optional access policy, validated at WRITE time (malformed
  // payloads are rejected before Prisma; providerKeys restricted to
  // override-capable connectors inside the schema itself).
  policy: apiKeyPolicySchema.optional(),
});

export type CreateKeyDto = z.infer<typeof CreateKeySchema>;

// CONN-1665 — PATCH /admin/keys/:id/policy body. `policy: null` clears.
export const SetKeyPolicySchema = z.object({
  policy: apiKeyPolicySchema.nullable(),
});

export type SetKeyPolicyDto = z.infer<typeof SetKeyPolicySchema>;

export const ResetCircuitBreakerSchema = z.object({
  connector: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
});

export type ResetCircuitBreakerDto = z.infer<typeof ResetCircuitBreakerSchema>;
