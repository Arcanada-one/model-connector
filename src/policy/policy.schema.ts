// CONN-1665 — per-API-key access policy: shape + write-time validation.
//
// SINGLE SOURCE OF TRUTH for the `ApiKey.policy` JSONB column (see
// prisma/schema.prisma). The admin API validates against this schema BEFORE
// anything reaches Prisma; the runtime read path (`PolicyService`) re-parses
// defensively and fails closed on a malformed stored value.
//
// SECURITY INVARIANTS (consilium-fixed, do not relax):
//  - Legacy providerKeys are environment names; version 2 uses registered
//    reference/version lists. Neither contains upstream secret values.
//    Registry resolution additionally checks provider, profile and client identity.
//  - `providerKeys` keys are restricted at WRITE time to connectors that
//    honour a per-request key override (`KEY_OVERRIDE_CAPABLE`). Only
//    retrofitted connectors read the override context — naming any other
//    provider here would silently fall back to the SHARED env key, so such a
//    policy is REJECTED instead (fail-closed).

import { z } from 'zod';
import { profileSpendPolicySchema } from '../billing/profile-spend/policy';

/**
 * Connectors that support a per-request provider-key override via
 * `providerKeyContext` (src/policy/provider-key.context.ts). Extend ONLY after
 * retrofitting the connector to consult the context (see
 * openrouter.connector.ts `getHeaders()` for the reference implementation).
 */
export const KEY_OVERRIDE_CAPABLE = ['openrouter', 'typesafe-jev', 'deepseek'];

/** Uppercase env-var NAME (e.g. OPENROUTER_API_KEY_EMAIL_AGENT) — never a key value. */
const referenceSchema = z
  .object({
    credentialRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  })
  .strict();

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
    policyVersion: z.union([z.literal(1), z.literal(2)]),
    profile: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        accountingBucket: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      })
      .strict()
      .optional(),
    /** Allowed connector names. Absent = all providers (legacy unrestricted). */
    providers: z.array(z.string().min(1)).min(1).optional(),
    /** Model restriction. Absent = all models of the allowed providers. */
    models: modelPolicySchema.optional(),
    spend: profileSpendPolicySchema.optional(),
    /**
     * Provider name to legacy environment name or registered reference list.
     * Version 2 pins the first reference; no automatic credential failover.
     */
    providerKeys: z
      .record(
        z.string().min(1),
        z.union([
          z.string().regex(ENV_VAR_NAME_RE, 'Legacy provider key must be an environment name'),
          z.array(referenceSchema).min(1).max(16),
        ]),
      )
      .optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.spend) {
      if (policy.policyVersion !== 2)
        ctx.addIssue({ code: 'custom', message: 'Spend profiles require policy version 2' });
      const providers = Object.keys(policy.spend.providers);
      if (
        providers.length !== policy.providers?.length ||
        providers.some((p) => !policy.providers?.includes(p))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Every dedicated provider requires a spend profile',
        });
      if (
        new Set(Object.values(policy.spend.providers).map((p) => p.profileId)).size !==
        providers.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Accounting profile identities must be distinct per provider',
        });
    }

    if (
      policy.policyVersion === 2 &&
      (!policy.profile || !policy.providers || !policy.providerKeys)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Version 2 requires profile, providers and providerKeys',
      });
    }
    if (policy.policyVersion === 1 && policy.profile) {
      ctx.addIssue({ code: 'custom', message: 'Profile requires version 2' });
    }
    for (const [provider, binding] of Object.entries(policy.providerKeys ?? {})) {
      if (
        policy.policyVersion === 2 &&
        (typeof binding === 'string' || !policy.providers?.includes(provider))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['providerKeys', provider],
          message: 'Version 2 requires registered references for an allowed provider',
        });
      }
      if (
        policy.policyVersion === 1 &&
        (typeof binding !== 'string' || provider !== 'openrouter')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['providerKeys', provider],
          message: 'New provider bindings require version 2 registered references',
        });
      }
    }
    if (policy.policyVersion === 2) {
      for (const provider of policy.providers ?? []) {
        if (!Object.hasOwn(policy.providerKeys ?? {}, provider)) {
          ctx.addIssue({
            code: 'custom',
            path: ['providers'],
            message: 'Every dedicated provider needs a binding',
          });
        }
      }
    }
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
