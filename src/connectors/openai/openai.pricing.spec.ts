import { describe, expect, it } from 'vitest';
import {
  GPT_6_1_TERRA_PRICE_BOOK,
  OPENAI_LONG_CONTEXT_INPUT_TOKENS,
  OPENAI_MODEL_PRICE_BOOKS,
  contextBandForInputTokens,
  lookupOpenAiRates,
  openAiCataloguePricing,
  openAiModelLimits,
} from './openai.pricing';

describe('openai.pricing — gpt-6.1-terra (retrieved 2026-10-28)', () => {
  it('publishes context window 1.05M and max output 128K', () => {
    expect(openAiModelLimits('gpt-6.1-terra')).toEqual({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
    expect(GPT_6_1_TERRA_PRICE_BOOK.retrievedAt).toBe('2026-10-28');
  });

  it('standard short-context matches developers.openai.com/api/docs/pricing only', () => {
    expect(lookupOpenAiRates('gpt-6.1-terra', 'standard', 'short')).toEqual({
      inputPerMTok: 1.0,
      cachedInputPerMTok: 0.05,
      outputPerMTok: 5.0,
    });
    expect(openAiCataloguePricing('gpt-6.1-terra')).toEqual({
      inputPerMTok: 1.0,
      cachedInputPerMTok: 0.05,
      outputPerMTok: 5.0,
      unit: 'USD/1M tokens',
    });
  });

  it('long-context rates apply when input exceeds 272K', () => {
    expect(OPENAI_LONG_CONTEXT_INPUT_TOKENS).toBe(272_000);
    expect(contextBandForInputTokens(272_000)).toBe('short');
    expect(contextBandForInputTokens(272_001)).toBe('long');
    expect(lookupOpenAiRates('gpt-6.1-terra', 'standard', 'long')).toEqual({
      inputPerMTok: 2.0,
      cachedInputPerMTok: 0.1,
      outputPerMTok: 7.5,
    });
  });

  it('Batch and Flex are 50% of Standard; Fast is 2×', () => {
    const standard = lookupOpenAiRates('gpt-6.1-terra', 'standard', 'short')!;
    const batch = lookupOpenAiRates('gpt-6.1-terra', 'batch', 'short')!;
    const flex = lookupOpenAiRates('gpt-6.1-terra', 'flex', 'short')!;
    const fast = lookupOpenAiRates('gpt-6.1-terra', 'fast', 'short')!;

    expect(batch).toEqual({
      inputPerMTok: standard.inputPerMTok * 0.5,
      cachedInputPerMTok: standard.cachedInputPerMTok * 0.5,
      outputPerMTok: standard.outputPerMTok * 0.5,
    });
    expect(flex).toEqual(batch);
    expect(fast).toEqual({
      inputPerMTok: standard.inputPerMTok * 2,
      cachedInputPerMTok: standard.cachedInputPerMTok * 2,
      outputPerMTok: standard.outputPerMTok * 2,
    });

    const longStandard = lookupOpenAiRates('gpt-6.1-terra', 'standard', 'long')!;
    expect(lookupOpenAiRates('gpt-6.1-terra', 'batch', 'long')).toEqual({
      inputPerMTok: longStandard.inputPerMTok * 0.5,
      cachedInputPerMTok: longStandard.cachedInputPerMTok * 0.5,
      outputPerMTok: longStandard.outputPerMTok * 0.5,
    });
    expect(lookupOpenAiRates('gpt-6.1-terra', 'fast', 'long')).toEqual({
      inputPerMTok: longStandard.inputPerMTok * 2,
      cachedInputPerMTok: longStandard.cachedInputPerMTok * 2,
      outputPerMTok: longStandard.outputPerMTok * 2,
    });
  });

  it('does not invent prices for unknown models', () => {
    expect(lookupOpenAiRates('gpt-does-not-exist')).toBeNull();
    expect(openAiCataloguePricing('gpt-does-not-exist')).toBeNull();
    expect(openAiModelLimits('gpt-does-not-exist')).toBeNull();
  });

  it('does not publish unconfirmed siblings (terra-pro / azure / eu)', () => {
    // Held back until a human confirms them on the OpenAI pricing page (#5580).
    expect(lookupOpenAiRates('gpt-6.1-terra-pro')).toBeNull();
    expect(lookupOpenAiRates('gpt-6.1-terra-azure')).toBeNull();
    expect(lookupOpenAiRates('gpt-6.1-terra-eu')).toBeNull();
    expect(OPENAI_MODEL_PRICE_BOOKS['gpt-6.1-terra-pro']).toBeUndefined();
  });
});
