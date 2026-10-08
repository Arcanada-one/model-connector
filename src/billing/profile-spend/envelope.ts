import { z } from 'zod';

const sequence = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((s) => BigInt(s) <= 9223372036854775807n);
const nano = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const text = z.string().min(1).max(256);
const utc = z.iso.datetime();
export const spendEventSchema = z
  .object({
    sequence,
    kind: z.enum(['reservation', 'claimed', 'dispatch_started', 'observation']),
    observedAt: utc,
    attempt: z
      .object({
        id: z.uuid(),
        accountId: text,
        ownerProfileId: text,
        clientKeyId: text,
        profileId: text,
        provider: text,
        model: text,
        runId: text,
        intentKey: text,
        digest: text,
        credentialRef: text,
        credentialVersion: text,
        admittedAt: utc,
        nodes: z.array(text).min(1).max(32),
        state: z.enum(['reserved', 'claimed', 'dispatch_started', 'completed', 'uncertain']),
        currency: z.literal('USD'),
        reserveNano: nano,
        observedNano: nano.nullable(),
        heldNano: nano,
        inputTokens: nano.nullable(),
        outputTokens: nano.nullable(),
        reconciliation: z.literal('NOT_MEASURED'),
        policyRevision: text,
        policyHash: text,
        tariffRevision: text,
        tariffHash: text,
        admissionCaps: z
          .array(
            z
              .object({
                authority: z.literal('mc_client'),
                scope: z.enum(['mc_client_currency', 'provider_profile', 'run']),
                profileId: text.nullable(),
                runId: text.nullable(),
                period: z.enum(['day', 'month', 'run']),
                from: utc,
                to: utc,
                observedAt: utc,
                limitNano: nano,
                exposureNano: nano,
                policyRevision: text,
                outboxId: sequence.nullable(),
              })
              .strict(),
          )
          .length(5),
      })
      .strict()
      .superRefine((attempt, ctx) => {
        if (
          BigInt(attempt.heldNano) < BigInt(attempt.reserveNano) ||
          (attempt.observedNano !== null && BigInt(attempt.heldNano) < BigInt(attempt.observedNano))
        )
          ctx.addIssue({
            code: 'custom',
            path: ['heldNano'],
            message: 'Held exposure must cover reservation and observed cost',
          });
      }),
  })
  .strict();
export const spendPageSchema = z
  .object({
    schema: z.literal('MCProfileSpendEvents/v1'),
    ledgerId: z.uuid(),
    accountId: text,
    ownerProfileId: text,
    after: sequence,
    through: sequence,
    watermark: sequence,
    observedAt: utc,
    events: z.array(spendEventSchema).max(500),
  })
  .strict();
export type SpendPage = z.infer<typeof spendPageSchema>;
export type SpendEvent = z.infer<typeof spendEventSchema>;
export const spendCursorSchema = sequence;
