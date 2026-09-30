import { createHash } from 'crypto';
import { z } from 'zod';

const label = z.string().min(1).max(2048);
const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)
  .refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s));
const probability = z.number().min(0).max(1);
const choiceCriteria = z.record(identifier, label).refine((v) => {
  const n = Object.keys(v).length;
  return n >= 2 && n <= 32;
});
const question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), instructions: label, criteria: choiceCriteria }).strict(),
  z
    .object({
      type: z.literal('score'),
      instructions: label,
      criteria: z.array(label).min(2).max(32),
    })
    .strict(),
  z
    .object({
      type: z.literal('noul'),
      instructions: label,
      criteria: z.object({ true: label, false: label }).strict().optional(),
    })
    .strict(),
]);

/** Provider-neutral envelope; questions deliberately retain the native primitives. */
export const DecisionRequestSchema = z
  .object({
    version: z.literal('DecisionRequest/v1'),
    mode: z.literal('shadow'),
    decisionType: identifier,
    policyId: identifier,
    model: z.literal('jev-latest'),
    state: z.string().min(1).max(18000),
    questions: z.record(identifier, question).refine((v) => {
      const n = Object.keys(v).length;
      return n >= 1 && n <= 32;
    }),
  })
  .strict();
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

const choiceAnswer = z
  .object({
    choice: z.string(),
    confidence: probability.optional(),
    probabilities: z.record(z.string(), probability).optional(),
  })
  .strip();
const scoreAnswer = z.object({ score: z.number().min(0) }).strip();
const noulAnswer = z.object({ noul: probability }).strip();
const responseSchema = z
  .object({
    model: z.string().min(1).max(256).optional(),
    answers: z.record(z.string(), z.unknown()),
  })
  .strip();
export type DecisionAnswer =
  | {
      primitive: 'choice';
      choice: string;
      confidence: number | null;
      probabilities: Record<string, number> | null;
    }
  | { primitive: 'score'; score: number }
  | { primitive: 'noul'; noul: number };
export interface DecisionResult {
  version: 'DecisionResult/v1';
  mode: 'shadow';
  action: 'none';
  decisionType: string;
  policyId: string;
  requestSha256: string;
  requestedModel: string;
  observedModel: string | null;
  status: 'observed' | 'unknown';
  reason: string | null;
  answers: Record<string, DecisionAnswer>;
}

export function nativeRequest(request: DecisionRequest) {
  return { model: request.model, state: request.state, questions: request.questions };
}

export function unknownDecision(request: DecisionRequest, reason: string): DecisionResult {
  return {
    version: 'DecisionResult/v1',
    mode: 'shadow',
    action: 'none',
    decisionType: request.decisionType,
    policyId: request.policyId,
    requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    requestedModel: request.model,
    observedModel: null,
    status: 'unknown',
    reason,
    answers: {},
  };
}

/** Reject incomplete or out-of-domain answers atomically; never turn absence into zero. */
export function normalizeDecision(request: DecisionRequest, input: unknown): DecisionResult {
  const result = unknownDecision(request, 'invalid_response');
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) return result;
  const response = parsed.data;
  const names = Object.keys(request.questions);
  if (Object.keys(response.answers).length !== names.length) return result;
  const answers: Record<string, DecisionAnswer> = {};
  for (const name of names) {
    if (!Object.hasOwn(response.answers, name)) return result;
    const q = request.questions[name];
    const raw = response.answers[name];
    if (q.type === 'choice') {
      const a = choiceAnswer.safeParse(raw);
      if (!a.success || !Object.hasOwn(q.criteria, a.data.choice)) return result;
      const probabilities = a.data.probabilities;
      if (probabilities) {
        const keys = Object.keys(probabilities);
        if (
          keys.length !== Object.keys(q.criteria).length ||
          keys.some((k) => !Object.hasOwn(q.criteria, k))
        )
          return result;
        if (Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 1e-5)
          return result;
        const selected = probabilities[a.data.choice];
        if (Object.values(probabilities).some((p) => p > selected + 1e-5)) return result;
        if (a.data.confidence !== undefined && Math.abs(a.data.confidence - selected) > 1e-5)
          return result;
      }
      answers[name] = {
        primitive: 'choice',
        choice: a.data.choice,
        confidence: a.data.confidence ?? null,
        probabilities: probabilities ?? null,
      };
    } else if (q.type === 'score') {
      // Native Score is a continuous position over the supplied ordered criteria.
      const a = scoreAnswer.safeParse(raw);
      if (!a.success || a.data.score > q.criteria.length - 1) return result;
      answers[name] = { primitive: 'score', score: a.data.score };
    } else {
      const a = noulAnswer.safeParse(raw);
      if (!a.success) return result;
      answers[name] = { primitive: 'noul', noul: a.data.noul };
    }
  }
  return {
    ...result,
    status: 'observed',
    reason: null,
    observedModel: response.model ?? null,
    answers,
  };
}
