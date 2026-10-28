/**
 * OpenAI curated price book (USD per 1M tokens).
 *
 * Retrieved 2026-10-28 from:
 * - https://developers.openai.com/api/docs/pricing
 * - https://openai.com/index/introducing-gpt-6-1-terra/
 *
 * Short context: ≤272K input tokens. Long context: >272K input tokens.
 * Batch and Flex are 50% of Standard; Fast is 2× Standard.
 * Cache-write (30m / 12h) tiers from the pricing page are recorded only in
 * comments here — metering does not yet consume them.
 */

export const OPENAI_PRICE_UNIT = 'USD/1M tokens';

/** Input-token threshold that switches Terra onto long-context rates. */
export const OPENAI_LONG_CONTEXT_INPUT_TOKENS = 272_000;

export type OpenAiProcessingTier = 'standard' | 'batch' | 'flex' | 'fast';
export type OpenAiContextBand = 'short' | 'long';

export interface OpenAiTokenRates {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

export interface OpenAiModelPriceBook {
  /** ISO date the book was checked against the public pages. */
  retrievedAt: string;
  contextWindow: number;
  maxOutputTokens: number;
  longContextInputTokens: number;
  rates: Record<OpenAiProcessingTier, Record<OpenAiContextBand, OpenAiTokenRates>>;
}

/**
 * GPT-6.1 Terra — standard short-context matches the introducing post
 * ($1 / $0.05 / $5). Long-context and Batch/Flex/Fast match the API pricing
 * tables (Batch=Flex=0.5×, Fast=2× of the same band).
 */
export const GPT_6_1_TERRA_PRICE_BOOK: OpenAiModelPriceBook = {
  retrievedAt: '2026-10-28',
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  longContextInputTokens: OPENAI_LONG_CONTEXT_INPUT_TOKENS,
  rates: {
    standard: {
      short: { inputPerMTok: 1.0, cachedInputPerMTok: 0.05, outputPerMTok: 5.0 },
      long: { inputPerMTok: 2.0, cachedInputPerMTok: 0.1, outputPerMTok: 7.5 },
    },
    batch: {
      short: { inputPerMTok: 0.5, cachedInputPerMTok: 0.025, outputPerMTok: 2.5 },
      long: { inputPerMTok: 1.0, cachedInputPerMTok: 0.05, outputPerMTok: 3.75 },
    },
    flex: {
      short: { inputPerMTok: 0.5, cachedInputPerMTok: 0.025, outputPerMTok: 2.5 },
      long: { inputPerMTok: 1.0, cachedInputPerMTok: 0.05, outputPerMTok: 3.75 },
    },
    fast: {
      short: { inputPerMTok: 2.0, cachedInputPerMTok: 0.1, outputPerMTok: 10.0 },
      long: { inputPerMTok: 4.0, cachedInputPerMTok: 0.2, outputPerMTok: 15.0 },
    },
  },
};

export const OPENAI_MODEL_PRICE_BOOKS: Readonly<Record<string, OpenAiModelPriceBook>> = {
  'gpt-6.1-terra': GPT_6_1_TERRA_PRICE_BOOK,
};

export function contextBandForInputTokens(
  inputTokens: number,
  threshold: number = OPENAI_LONG_CONTEXT_INPUT_TOKENS,
): OpenAiContextBand {
  return inputTokens > threshold ? 'long' : 'short';
}

/** Rates for a model / processing tier / context band. */
export function lookupOpenAiRates(
  modelId: string,
  tier: OpenAiProcessingTier = 'standard',
  band: OpenAiContextBand = 'short',
): OpenAiTokenRates | null {
  const book = OPENAI_MODEL_PRICE_BOOKS[modelId];
  if (!book) return null;
  return book.rates[tier][band];
}

/**
 * Catalogue / metering floor: Standard processing, short-context band.
 * This connector's live requests run on Standard; Batch/Flex/Fast are not
 * reachable from the connector path today.
 */
export function openAiCataloguePricing(modelId: string): {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
  unit: string;
} | null {
  const rates = lookupOpenAiRates(modelId, 'standard', 'short');
  if (!rates) return null;
  return { ...rates, unit: OPENAI_PRICE_UNIT };
}

export function openAiModelLimits(modelId: string): {
  contextWindow: number;
  maxOutputTokens: number;
} | null {
  const book = OPENAI_MODEL_PRICE_BOOKS[modelId];
  if (!book) return null;
  return {
    contextWindow: book.contextWindow,
    maxOutputTokens: book.maxOutputTokens,
  };
}
