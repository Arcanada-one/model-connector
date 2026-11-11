import { z } from 'zod';

/**
 * Public POST /v1/decisions body (CONN-JEV-07).
 * Muneral AC wire: { template, state }. Also accepts template_ref {id, version}
 * and optional DecisionRequest/v1 companions. Inline questions are forbidden.
 */
const templateRefSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.number().int().positive().optional(),
  })
  .strict();

export const publicDecisionRequestSchema = z
  .object({
    schema: z.literal('DecisionRequest/v1').optional(),
    version: z.literal('DecisionRequest/v1').optional(),
    /** Muneral AC field — template id. */
    template: z.string().min(1).max(128).optional(),
    template_ref: templateRefSchema.optional(),
    template_params: z.record(z.string(), z.unknown()).optional(),
    state: z.unknown(),
    decision_type: z.string().min(1).max(128).optional(),
    mode: z.literal('shadow').optional(),
    risk_class: z.enum(['advisory', 'gating', 'high_risk_advisory']).optional(),
    privacy_class: z.enum(['public', 'internal', 'confidential']).optional(),
    // Forbidden smuggle paths — present → refused before network.
    questions: z.unknown().optional(),
    instructions: z.unknown().optional(),
    criteria: z.unknown().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.template && !val.template_ref) {
      ctx.addIssue({
        code: 'custom',
        message: 'template or template_ref is required',
        path: ['template'],
      });
    }
    if (val.privacy_class === undefined) return;
    // secret/regulated are never accepted (spec §7.7) — enum already excludes them.
  });

export type PublicDecisionRequestDto = z.infer<typeof publicDecisionRequestSchema>;

export function resolveTemplateIdentity(dto: PublicDecisionRequestDto): {
  id: string;
  version?: number;
} {
  if (dto.template_ref) {
    return { id: dto.template_ref.id, version: dto.template_ref.version };
  }
  return { id: dto.template as string };
}
