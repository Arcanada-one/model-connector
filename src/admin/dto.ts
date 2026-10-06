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

/**
 * A2-319 — PATCH /admin/keys/:id/rate-limit body.
 *
 * `rateLimit` carries the same bounds as creation, so the write path cannot
 * produce a value the create path would refuse. `actor` is REQUIRED because
 * `ADMIN_TOKEN` is one shared static secret and therefore not an identity
 * (consilium §4.6, the same argument BILL-0008 made for ledger entries): the
 * token proves the caller may change a limit, the actor says who did. It is a
 * short name, charset-restricted so it cannot smuggle a newline into the log.
 */
export const SetKeyRateLimitSchema = z.object({
  rateLimit: z.number().int().min(1).max(10000),
  actor: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._@:/-]+$/, 'actor: letters, digits and . _ @ : / - only'),
  reason: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^\r\n]*$/, 'reason: a single line')
    .optional(),
});

export type SetKeyRateLimitDto = z.infer<typeof SetKeyRateLimitSchema>;

export const ResetCircuitBreakerSchema = z.object({
  connector: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
});

export type ResetCircuitBreakerDto = z.infer<typeof ResetCircuitBreakerSchema>;
