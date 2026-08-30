/**
 * ARAS-0058 — the money meter.
 *
 * The bug under test is specific and was live in production: every `charge` row
 * in `credits_ledger` was $0.000000 because connectors captured tokens and then
 * returned `costUsd: 0`. So the load-bearing assertion here is not "the
 * arithmetic is right" but "a priced model with real tokens produces a NON-ZERO
 * number", and its counterpart, "an unpriced model is marked rather than
 * silently charged zero".
 */

import { describe, expect, it } from 'vitest';

import { measureCostUsd } from './measured-cost';

// Groq's published tariff for llama-3.3-70b-versatile, USD per 1M tokens.
const PRICED = { inputPerMTok: 0.59, outputPerMTok: 0.79, tier: 'paid' };

describe('measureCostUsd', () => {
  describe('a priced model charges real money', () => {
    it('turns measured tokens into a non-zero cost', () => {
      const measured = measureCostUsd({
        providerCostUsd: 0,
        inputTokens: 1_000,
        outputTokens: 500,
        pricing: PRICED,
      });

      // This is the assertion the whole stream exists for.
      expect(measured.costUsd).toBeGreaterThan(0);
      expect(measured.source).toBe('catalog');
      // 1000 * 0.59/1e6 + 500 * 0.79/1e6 = 0.00059 + 0.000395
      expect(measured.costUsd).toBeCloseTo(0.000985, 9);
    });

    it('charges more for more tokens', () => {
      const small = measureCostUsd({ inputTokens: 1_000, outputTokens: 1_000, pricing: PRICED });
      const large = measureCostUsd({
        inputTokens: 100_000,
        outputTokens: 100_000,
        pricing: PRICED,
      });
      expect(large.costUsd).toBeGreaterThan(small.costUsd);
    });

    it('charges output at the output rate, not the input rate', () => {
      // A meter that used one rate for both would pass every test above.
      const inputHeavy = measureCostUsd({ inputTokens: 10_000, outputTokens: 0, pricing: PRICED });
      const outputHeavy = measureCostUsd({ inputTokens: 0, outputTokens: 10_000, pricing: PRICED });
      expect(outputHeavy.costUsd).toBeGreaterThan(inputHeavy.costUsd);
    });

    it('prices a model that publishes only one side of the tariff', () => {
      // Dropping the whole calculation because one side is missing would throw
      // away a cost we do know.
      const measured = measureCostUsd({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        pricing: { inputPerMTok: 2, outputPerMTok: null, tier: 'paid' },
      });
      expect(measured.costUsd).toBe(2);
      expect(measured.source).toBe('catalog');
    });

    it('rounds to the six decimals the Decimal(10,6) column stores', () => {
      const measured = measureCostUsd({
        inputTokens: 1,
        outputTokens: 0,
        pricing: { inputPerMTok: 1.2345678, outputPerMTok: null, tier: 'paid' },
      });
      expect(measured.costUsd).toBe(0.000001);
    });

    it('charges zero for a tariff that is explicitly zero', () => {
      const measured = measureCostUsd({
        inputTokens: 10_000,
        outputTokens: 10_000,
        pricing: { inputPerMTok: 0, outputPerMTok: 0, tier: 'free' },
      });
      expect(measured.costUsd).toBe(0);
      // Priced — at zero. Not the same fact as "no price known".
      expect(measured.source).toBe('catalog');
    });
  });

  describe('an unpriced model is marked, never silently charged zero', () => {
    it('marks a model with no catalogue row at all', () => {
      const measured = measureCostUsd({
        providerCostUsd: 0,
        inputTokens: 1_000,
        outputTokens: 500,
        pricing: null,
      });
      expect(measured.source).toBe('unpriced');
      // Zero is what gets charged, because inventing a number to bill is worse.
      // The MARKER is what makes this different from the bug: it is queryable,
      // and `persistAndSettle` writes the ledger row as 'model-request:unpriced',
      // in the same transaction as the `Request` row that carries the source.
      expect(measured.costUsd).toBe(0);
    });

    it('marks a catalogued model whose tier is unknown and tariffs are null', () => {
      const measured = measureCostUsd({
        inputTokens: 1_000,
        outputTokens: 500,
        pricing: { inputPerMTok: null, outputPerMTok: null, tier: 'unknown' },
      });
      expect(measured.source).toBe('unpriced');
      expect(measured.costUsd).toBe(0);
    });

    it('does NOT mark a catalogued free-tier model as unpriced', () => {
      // Every groq chat model looks like this: CONN-1672 suppresses the reported
      // list price precisely because the free tier is genuinely $0, so the row
      // carries tier=free with NULL tariffs. That is a known price, and
      // collapsing it into 'unpriced' would drown the marker in noise.
      const measured = measureCostUsd({
        inputTokens: 1_000,
        outputTokens: 500,
        pricing: { inputPerMTok: null, outputPerMTok: null, tier: 'free' },
      });
      expect(measured.source).toBe('catalog-free');
      expect(measured.costUsd).toBe(0);
    });

    it('does not treat a rejected or errored request as unpriced', () => {
      // No tokens were consumed, so nothing is owed at any tariff — including
      // one we do not know. Keeping these out of 'unpriced' is what keeps the
      // marker worth reading.
      const measured = measureCostUsd({ inputTokens: 0, outputTokens: 0, pricing: null });
      expect(measured.source).toBe('zero-usage');
      expect(measured.costUsd).toBe(0);
    });
  });

  describe('a provider-reported cost is authoritative', () => {
    it('keeps the provider figure and ignores the catalogue', () => {
      // claude-code reads `total_cost_usd`, openrouter reads `usage.total_cost`.
      // That is the provider's own invoice; a catalogue tariff is our copy of a
      // published price and must not overwrite it.
      const measured = measureCostUsd({
        providerCostUsd: 0.4242,
        inputTokens: 1_000,
        outputTokens: 500,
        pricing: PRICED,
      });
      expect(measured.costUsd).toBe(0.4242);
      expect(measured.source).toBe('provider');
    });

    it('falls back to the catalogue when the provider reports nothing', () => {
      const measured = measureCostUsd({
        providerCostUsd: null,
        inputTokens: 1_000,
        outputTokens: 500,
        pricing: PRICED,
      });
      expect(measured.source).toBe('catalog');
      expect(measured.costUsd).toBeGreaterThan(0);
    });
  });

  describe('rubbish in does not become money out', () => {
    it('ignores a negative provider cost', () => {
      const measured = measureCostUsd({
        providerCostUsd: -5,
        inputTokens: 1_000,
        outputTokens: 0,
        pricing: PRICED,
      });
      expect(measured.source).toBe('catalog');
      expect(measured.costUsd).toBeGreaterThan(0);
    });

    it('ignores a NaN provider cost', () => {
      const measured = measureCostUsd({
        providerCostUsd: Number.NaN,
        inputTokens: 1_000,
        outputTokens: 0,
        pricing: PRICED,
      });
      expect(measured.source).toBe('catalog');
      expect(Number.isFinite(measured.costUsd)).toBe(true);
    });

    it('never returns a negative charge from a negative tariff', () => {
      // A negative price would credit the account on every call. Refuse to read
      // it rather than pay customers to use the service.
      const measured = measureCostUsd({
        inputTokens: 1_000,
        outputTokens: 0,
        pricing: { inputPerMTok: -1, outputPerMTok: null, tier: 'paid' },
      });
      expect(measured.costUsd).toBe(0);
      expect(measured.source).toBe('unpriced');
    });

    it('treats a negative token count as zero rather than as a refund', () => {
      const measured = measureCostUsd({
        inputTokens: -1_000,
        outputTokens: 1_000,
        pricing: PRICED,
      });
      expect(measured.costUsd).toBeGreaterThan(0);
      expect(measured.costUsd).toBeCloseTo(0.00079, 9);
    });
  });

  // --- CONN-0272: the breakdown behind the total ---------------------------

  describe('the cost breakdown', () => {
    it('splits the total into input and output, and the halves sum to it', () => {
      const measured = measureCostUsd({
        inputTokens: 1_000,
        outputTokens: 500,
        pricing: PRICED,
      });

      // 1000 * 0.59/1e6 = 0.00059 input; 500 * 0.79/1e6 = 0.000395 output.
      expect(measured.inputCostUsd).toBeCloseTo(0.00059, 9);
      expect(measured.outputCostUsd).toBeCloseTo(0.000395, 9);
      // The invariant that makes the split trustworthy: it must reconcile to
      // the number actually charged, or the breakdown is decorative.
      expect((measured.inputCostUsd ?? 0) + (measured.outputCostUsd ?? 0)).toBeCloseTo(
        measured.costUsd,
        9,
      );
    });

    it('does not put the whole bill on one side', () => {
      // A breakdown that assigned everything to input would satisfy the sum
      // check above, so pin both halves as independently non-zero.
      const measured = measureCostUsd({
        inputTokens: 10_000,
        outputTokens: 10_000,
        pricing: PRICED,
      });
      expect(measured.inputCostUsd).toBeGreaterThan(0);
      expect(measured.outputCostUsd).toBeGreaterThan(0);
      expect(measured.inputCostUsd).not.toBe(measured.outputCostUsd);
    });

    it('reports null halves for a provider invoice rather than inventing a split', () => {
      const measured = measureCostUsd({
        providerCostUsd: 0.25,
        inputTokens: 1_000,
        outputTokens: 500,
        pricing: PRICED,
      });
      expect(measured.source).toBe('provider');
      expect(measured.costUsd).toBe(0.25);
      // The provider billed one number. Splitting it by our own tariff would
      // produce two figures that look measured and are not.
      expect(measured.inputCostUsd).toBeNull();
      expect(measured.outputCostUsd).toBeNull();
    });

    it('reports null halves for an unpriced model, not zeros', () => {
      const measured = measureCostUsd({ inputTokens: 1_000, outputTokens: 500, pricing: null });
      expect(measured.source).toBe('unpriced');
      // Zeros here would read as "measured, and it was free" — the exact
      // ambiguity costSource exists to remove.
      expect(measured.inputCostUsd).toBeNull();
      expect(measured.outputCostUsd).toBeNull();
    });
  });

  describe('cached input is billed at the cache rate', () => {
    const CACHED = { inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: 0.1, tier: 'paid' };

    it('charges less when part of the prompt came from cache', () => {
      const cold = measureCostUsd({ inputTokens: 10_000, outputTokens: 0, pricing: CACHED });
      const warm = measureCostUsd({
        inputTokens: 10_000,
        cachedInputTokens: 10_000,
        outputTokens: 0,
        pricing: CACHED,
      });

      // The whole economic point of caching. A meter that merely CARRIED the
      // cached count without pricing it would return the same number twice and
      // fail here.
      expect(warm.costUsd).toBeLessThan(cold.costUsd);
      // 10_000 at 0.1/1e6 = 0.001 against 10_000 at 1/1e6 = 0.01. A tenth.
      expect(warm.costUsd).toBeCloseTo(cold.costUsd / 10, 12);
    });

    it('treats cached tokens as a subset of input, never as extra tokens', () => {
      // If cached were added to input instead of carved out of it, this would
      // cost MORE than the uncached call, not less.
      const measured = measureCostUsd({
        inputTokens: 10_000,
        cachedInputTokens: 4_000,
        outputTokens: 0,
        pricing: CACHED,
      });
      // Rates are USD per 1M, as in PRICED above.
      // 6_000 * 1/1e6 = 0.006 uncached; 4_000 * 0.1/1e6 = 0.0004 cached.
      expect(measured.costUsd).toBeCloseTo(0.0064, 9);
    });

    it('falls back to the full input rate when no cache tariff is published', () => {
      // Conservative on purpose: assuming a discount nobody published would
      // under-bill. Same cost with or without the cached count.
      const withCache = measureCostUsd({
        inputTokens: 10_000,
        cachedInputTokens: 10_000,
        outputTokens: 0,
        pricing: PRICED,
      });
      const without = measureCostUsd({ inputTokens: 10_000, outputTokens: 0, pricing: PRICED });
      expect(withCache.costUsd).toBe(without.costUsd);
    });

    it('clamps a cached count larger than the input count instead of crediting it', () => {
      // A provider bug must not become a negative charge.
      const measured = measureCostUsd({
        inputTokens: 1_000,
        cachedInputTokens: 999_999,
        outputTokens: 0,
        pricing: CACHED,
      });
      expect(measured.costUsd).toBeGreaterThanOrEqual(0);
      // Clamped to inputTokens, so all 1_000 bill at the cache rate:
      // 1_000 * 0.1/1e6 = 0.0001. Not a credit, and not the 999_999 claimed.
      expect(measured.costUsd).toBeCloseTo(0.0001, 9);
    });
  });
});
