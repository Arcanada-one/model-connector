import { z } from 'zod';

const thinkingSchema = z.object({ type: z.enum(['enabled', 'disabled']) }).strict();
const effortSchema = z.enum(['low', 'high', 'max']);
const mappedEffort = { low: 'low', medium: 'high', high: 'high' } as const;

// The shared MC effort vocabulary maps explicitly to DeepSeek's documented
// vocabulary. An omitted mode/effort stays omitted; disabled plus effort refuses.
const optionsSchema = z
  .object({
    thinking: thinkingSchema.optional(),
    reasoning_effort: effortSchema.optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .superRefine((options, ctx) => {
    if (
      options.thinking?.type === 'disabled' &&
      (options.effort !== undefined || options.reasoning_effort !== undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Disabled thinking cannot specify effort' });
    }
    if (
      options.effort !== undefined &&
      options.reasoning_effort !== undefined &&
      mappedEffort[options.effort] !== options.reasoning_effort
    ) {
      ctx.addIssue({ code: 'custom', message: 'Conflicting DeepSeek effort fields' });
    }
  });

export function parseDeepSeekOptions(request: {
  effort?: unknown;
  extra?: Record<string, unknown>;
}) {
  return optionsSchema.safeParse({
    thinking: request.extra?.thinking,
    reasoning_effort: request.extra?.reasoning_effort,
    effort: request.effort,
  });
}

export function deepSeekBodyOptions(request: {
  effort?: unknown;
  extra?: Record<string, unknown>;
}): { thinking?: z.infer<typeof thinkingSchema>; reasoning_effort?: string } {
  const parsed = parseDeepSeekOptions(request);
  if (!parsed.success) throw new Error('Invalid DeepSeek thinking/effort options');
  const options = parsed.data;
  const effort =
    options.reasoning_effort ??
    (options.effort === undefined ? undefined : mappedEffort[options.effort]);
  return {
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  };
}
