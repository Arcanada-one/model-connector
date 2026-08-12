// CONN-1665 — per-API-key access policy: shape + write-time validation.
//
// SINGLE SOURCE OF TRUTH for the `ApiKey.policy` JSONB column (see
// prisma/schema.prisma). The admin API validates against this schema BEFORE
// anything reaches Prisma; the runtime read path (`PolicyService`) re-parses
// defensively and fails closed on a malformed stored value.
//
// SECURITY INVARIANTS (consilium-fixed, do not relax):
//  - `providerKeys` values are ENV VAR *NAMES* (indirection), never key values.
//    A raw secret can never round-trip through this schema (regex rejects
//    lowercase/`-`/`sk-...` shapes).
//  - `providerKeys` keys are restricted at WRITE time to connectors that
//    honour a per-request key override (`KEY_OVERRIDE_CAPABLE`). Only
//    retrofitted connectors read the override context — naming any other
//    provider here would silently fall back to the SHARED env key, so such a
//    policy is REJECTED instead (fail-closed).

import { z } from 'zod';

/**
 * Connectors that support a per-request provider-key override via
 * `providerKeyContext` (src/policy/provider-key.context.ts). Extend ONLY after
 * retrofitting the connector to consult the context (see
 * openrouter.connector.ts `getHeaders()` for the reference implementation).
 */
export const KEY_OVERRIDE_CAPABLE = ['openrouter'];

/** Uppercase env-var NAME (e.g. OPENROUTER_API_KEY_EMAIL_AGENT) — never a key value. */
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const modelPolicySchema = z
  .object({
    mode: z.enum(['all', 'free-only', 'list']),
    list: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((models, ctx) => {
    if (models.mode === 'list' && models.list === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['list'],
        message: "models.mode 'list' requires a non-empty 'list' of model ids",
      });
    }
    if (models.mode !== 'list' && models.list !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['list'],
        message: `models.list is only valid with mode 'list' (got mode '${models.mode}')`,
      });
    }
  });

export const apiKeyPolicySchema = z
  .object({
    policyVersion: z.literal(1),
    /** Allowed connector names. Absent = all providers (legacy unrestricted). */
    providers: z.array(z.string().min(1)).min(1).optional(),
    /** Model restriction. Absent = all models of the allowed providers. */
    models: modelPolicySchema.optional(),
    /**
     * provider name → ENV VAR NAME holding that provider's dedicated API key.
     * Values are indirection names, NEVER key material.
     */
    providerKeys: z
      .record(
        z.string().min(1),
        z
          .string()
          .regex(
            ENV_VAR_NAME_RE,
            'providerKeys values must be UPPER_SNAKE env var NAMES, never key values',
          ),
      )
      .optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    for (const provider of Object.keys(policy.providerKeys ?? {})) {
      if (!KEY_OVERRIDE_CAPABLE.includes(provider)) {
        ctx.addIssue({
          code: 'custom',
          path: ['providerKeys', provider],
          message:
            `provider '${provider}' does not support per-key API-key override ` +
            `(supported: ${KEY_OVERRIDE_CAPABLE.join(', ')})`,
        });
      }
    }
  });

export type ApiKeyPolicy = z.infer<typeof apiKeyPolicySchema>;
export type ModelPolicy = z.infer<typeof modelPolicySchema>;
