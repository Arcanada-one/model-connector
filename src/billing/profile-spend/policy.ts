import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const moneyStringSchema = z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,9})?$/);
const utc = z.iso.datetime({ offset: false });
const tariff = z
  .object({
    revision: id,
    sourceRef: z.string().min(1).max(256),
    validFrom: utc,
    validUntil: utc,
    inputPerMTok: moneyStringSchema,
    outputPerMTok: moneyStringSchema,
    inputTokenBound: z.number().int().min(1).max(2_000_000),
    maxOutputTokens: z.number().int().min(1).max(1_000_000),
    maxPayloadBytes: z.number().int().min(1).max(262_144),
    boundAuthority: id,
  })
  .strict()
  .refine((v) => v.validFrom < v.validUntil, 'Tariff validity interval must be ordered');
export const profileSpendPolicySchema = z
  .object({
    mode: z.literal('strict'),
    revision: id,
    currency: z.literal('USD'),
    effectiveFrom: utc,
    effectiveUntil: utc,
    client: z
      .object({
        dailyLimit: moneyStringSchema,
        monthlyLimit: moneyStringSchema,
        runLimit: moneyStringSchema,
        maxConcurrent: z.number().int().min(1).max(64),
      })
      .strict(),
    providers: z
      .record(
        z.string().min(1),
        z
          .object({
            profileId: id,
            dailyLimit: moneyStringSchema,
            monthlyLimit: moneyStringSchema,
            models: z.record(z.string().min(1), tariff).refine((v) => Object.keys(v).length > 0),
          })
          .strict(),
      )
      .refine((v) => Object.keys(v).length > 0),
  })
  .strict()
  .refine((v) => v.effectiveFrom < v.effectiveUntil, 'Budget validity interval must be ordered');
export type ProfileSpendPolicy = z.infer<typeof profileSpendPolicySchema>;
export const spendContextSchema = z
  .object({
    version: z.literal('profile-spend/v1'),
    runId: id,
    nodes: z
      .array(id)
      .min(1)
      .max(32)
      .refine((v) => new Set(v).size === v.length, 'Duplicate node membership'),
  })
  .strict();
export type SpendContext = z.infer<typeof spendContextSchema>;
