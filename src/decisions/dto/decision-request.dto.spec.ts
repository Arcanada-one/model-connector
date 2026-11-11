import { describe, expect, it } from 'vitest';
import { publicDecisionRequestSchema, resolveTemplateIdentity } from './decision-request.dto';

describe('publicDecisionRequestSchema', () => {
  it('accepts Muneral AC wire {template, state}', () => {
    const parsed = publicDecisionRequestSchema.parse({
      template: 'task.intent',
      state: { trusted: { task_text: 'ship route' } },
    });
    expect(resolveTemplateIdentity(parsed)).toEqual({ id: 'task.intent' });
  });

  it('accepts template_ref', () => {
    const parsed = publicDecisionRequestSchema.parse({
      template_ref: { id: 'retrieval.relevance', version: 1 },
      state: { trusted: { question: 'q' }, untrusted: { candidates: [] } },
    });
    expect(resolveTemplateIdentity(parsed)).toEqual({
      id: 'retrieval.relevance',
      version: 1,
    });
  });

  it('rejects missing template identity', () => {
    const result = publicDecisionRequestSchema.safeParse({
      state: { trusted: { task_text: 'x' } },
    });
    expect(result.success).toBe(false);
  });

  it('parses but leaves inline questions for service-level refuse', () => {
    const parsed = publicDecisionRequestSchema.parse({
      template: 'task.intent',
      state: { trusted: { task_text: 'x' } },
      questions: { bad: true },
    });
    expect(parsed.questions).toEqual({ bad: true });
  });
});
