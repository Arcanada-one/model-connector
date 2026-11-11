import { describe, expect, it } from 'vitest';
import { validateTemplateRequest } from './validate';
import { listTemplateIds } from './registry';

describe('validateTemplateRequest (ARCA-JEV-02 binding)', () => {
  it('accepts a known task.intent template with whitelisted state', () => {
    const result = validateTemplateRequest({
      templateId: 'task.intent',
      state: {
        trusted: {
          task_text: 'Add a typed decisions route',
          context_labels: { caller_kind: 'agent' },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('refuses an unknown template', () => {
    const result = validateTemplateRequest({
      templateId: 'does.not.exist',
      state: { trusted: { task_text: 'x' } },
    });
    expect(result).toMatchObject({ ok: false, code: 'unknown_template' });
  });

  it('refuses state field outside whitelist', () => {
    const result = validateTemplateRequest({
      templateId: 'task.intent',
      state: {
        trusted: { task_text: 'x', budget_usd: 12 },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_state' });
  });

  it('refuses deny-list field reviewer_note under untrusted (negative control)', () => {
    const result = validateTemplateRequest({
      templateId: 'retrieval.relevance',
      state: {
        trusted: { question: 'what is JEV?' },
        untrusted: {
          candidates: [{ k: 1, text: 'ok', reviewer_note: 'looks approved' }],
        },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'deny_list_field' });
  });

  it('refuses inline questions', () => {
    const result = validateTemplateRequest({
      templateId: 'task.intent',
      state: { trusted: { task_text: 'x' } },
      hasInlineQuestions: true,
    });
    expect(result).toMatchObject({ ok: false, code: 'inline_questions_forbidden' });
  });

  it('registers the first-queue template ids', () => {
    expect(listTemplateIds()).toEqual(
      expect.arrayContaining(['task.intent', 'task.domain', 'retrieval.relevance', 'health']),
    );
  });
});
