/**
 * #105 — reasoningOutputTokens must remain a subset of outputTokens so
 * measureCostUsd bills reasoning exactly once (via outputTokens × output rate).
 *
 * Providers that report reasoning as ADDITIVE (completion_tokens = visible only)
 * break that invariant in production; the normaliser folds them.
 */

import { describe, expect, it } from 'vitest';

import { measureCostUsd } from '../billing/measured-cost';
import { normalizeReasoningSubset } from './normalize-reasoning-usage';

// Catalogued grok-3 output rate cited in issue #105 (USD / 1M tokens).
const GROK3_OUTPUT = { inputPerMTok: 3.0, outputPerMTok: 15.0, tier: 'paid' };

describe('normalizeReasoningSubset (#105)', () => {
  it('leaves an already-subset reasoning count unchanged', () => {
    const out = normalizeReasoningSubset({ outputTokens: 100, reasoningOutputTokens: 80 });
    expect(out).toEqual({ outputTokens: 100, reasoningOutputTokens: 80 });
  });

  it('keeps undefined distinct from a measured zero', () => {
    expect(normalizeReasoningSubset({ outputTokens: 8 })).toEqual({ outputTokens: 8 });
    expect(normalizeReasoningSubset({ outputTokens: 8, reasoningOutputTokens: 0 })).toEqual({
      outputTokens: 8,
      reasoningOutputTokens: 0,
    });
  });

  it('folds additive reasoning into outputTokens (orq grok-3 prod shape from #105)', () => {
    // Measured end-to-end in #105: input 205, output 16, reasoning 357.
    const out = normalizeReasoningSubset({ outputTokens: 16, reasoningOutputTokens: 357 });
    expect(out.outputTokens).toBe(16 + 357);
    expect(out.reasoningOutputTokens).toBe(357);
    expect(out.reasoningOutputTokens as number).toBeLessThanOrEqual(out.outputTokens);
  });

  it('folds additive openrouter free-tier shape from #105', () => {
    const out = normalizeReasoningSubset({ outputTokens: 7051, reasoningOutputTokens: 7436 });
    expect(out.outputTokens).toBe(7051 + 7436);
    expect(out.reasoningOutputTokens).toBe(7436);
    expect(out.reasoningOutputTokens as number).toBeLessThanOrEqual(out.outputTokens);
  });

  it('with additive:true folds even when reasoning <= visible output (Codex)', () => {
    const out = normalizeReasoningSubset({
      outputTokens: 20,
      reasoningOutputTokens: 15,
      additive: true,
    });
    expect(out.outputTokens).toBe(35);
    expect(out.reasoningOutputTokens).toBe(15);
  });

  it('bills reasoning exactly once after fold (catalog path)', () => {
    const raw = { outputTokens: 16, reasoningOutputTokens: 357 };
    const folded = normalizeReasoningSubset(raw);
    const charged = measureCostUsd({
      inputTokens: 205,
      outputTokens: folded.outputTokens,
      pricing: GROK3_OUTPUT,
    });
    // Pre-fix meter charged only the visible 16: 16 * 15 / 1e6 = 0.000240.
    const visibleOnly = measureCostUsd({
      inputTokens: 205,
      outputTokens: 16,
      pricing: GROK3_OUTPUT,
    });
    expect(visibleOnly.outputCostUsd).toBe(0.00024);
    // After fold: 373 * 15 / 1e6 = 0.005595 — reasoning counted once via output.
    expect(charged.outputCostUsd).toBe(0.005595);
    expect(charged.costUsd).toBeGreaterThan(visibleOnly.costUsd);
  });
});
