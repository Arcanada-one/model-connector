/**
 * Protected-profile-only hard cost bound.
 *
 * Deliberately separate from {@link estimateCostUsd}: legacy / non-protected
 * traffic keeps the chars/4 + 2000-output-floor heuristic unchanged.
 *
 * The protected hold must be a true upper bound:
 * - input tokens: UTF-8 byte length of the final effective request parts
 *   (each byte is an upper bound of ≥1 token under any real tokenizer);
 * - output tokens: the caller `max_tokens` the admitted connector forwards;
 * - money: round UP to ledger precision (6 decimal places).
 */

import type { ContentBlock } from '../connectors/interfaces/connector.interface';

/** Ledger precision used by BillingService hold SQL (`toFixed(6)`). */
export const PROTECTED_HOLD_DECIMALS = 6;

/**
 * Chars/bytes charged for one image block when no provider counter exists.
 * ~1 000 tokens × worst-case multi-byte expansion headroom.
 */
const IMAGE_BLOCK_BYTE_ALLOWANCE = 8_000;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function promptUtf8Bytes(prompt: string | ContentBlock[] | undefined): number {
  if (prompt == null) return 0;
  if (typeof prompt === 'string') return utf8Bytes(prompt);
  if (!Array.isArray(prompt)) return 0;
  return prompt.reduce((total, block) => {
    if (block?.type === 'text') return total + utf8Bytes(block.text ?? '');
    if (block?.type === 'image_url') return total + IMAGE_BLOCK_BYTE_ALLOWANCE;
    return total;
  }, 0);
}

/**
 * Upper-bound input token count for the final effective protected request.
 * Uses UTF-8 bytes of prompt + system + tool names (no chars/4 undercount).
 */
export function protectedInputTokenUpperBound(parts: {
  prompt?: string | ContentBlock[];
  systemPrompt?: string;
  tools?: string[];
}): number {
  let bytes = promptUtf8Bytes(parts.prompt);
  if (typeof parts.systemPrompt === 'string' && parts.systemPrompt.length > 0) {
    bytes += utf8Bytes(parts.systemPrompt);
  }
  if (Array.isArray(parts.tools)) {
    for (const tool of parts.tools) {
      if (typeof tool === 'string') bytes += utf8Bytes(tool);
    }
  }
  return Math.max(0, bytes);
}

/**
 * Output token cap for a protected hold. Requires a finite positive
 * `max_tokens` that the admitted connector class actually forwards.
 */
export function protectedOutputTokenCap(params: {
  maxTokens: unknown;
  connectorForwardsMaxTokens: boolean;
}): number | null {
  if (!params.connectorForwardsMaxTokens) return null;
  if (
    typeof params.maxTokens !== 'number' ||
    !Number.isFinite(params.maxTokens) ||
    params.maxTokens <= 0
  ) {
    return null;
  }
  return Math.ceil(params.maxTokens);
}

/**
 * Round a non-negative USD amount UP to `decimals` places. Never rounds down
 * toward zero for a positive raw cost (unlike `Number#toFixed`).
 */
export function ceilUsdToLedgerPrecision(
  amount: number,
  decimals: number = PROTECTED_HOLD_DECIMALS,
): string {
  if (!Number.isFinite(amount) || amount < 0) {
    return 'NaN';
  }
  if (amount === 0) return (0).toFixed(decimals);
  const scale = 10 ** decimals;
  // Subtract a tiny epsilon before ceil so exact N.xxxxxx000… stay put;
  // for values that need rounding up, ceil still moves them up.
  const scaled = amount * scale;
  const ceiled = Math.ceil(scaled - Number.EPSILON * scale);
  return (ceiled / scale).toFixed(decimals);
}

export interface ProtectedHoldEstimateInput {
  inputTokenUpperBound: number;
  outputTokenCap: number;
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Protected-only hard hold. Does not share logic with {@link estimateCostUsd}.
 */
export function estimateProtectedHoldUsd(input: ProtectedHoldEstimateInput): number {
  const inputTokens = Math.max(0, Math.ceil(input.inputTokenUpperBound));
  const outputTokens = Math.max(0, Math.ceil(input.outputTokenCap));
  const inputCost = (input.inputPerMTok * inputTokens) / 1_000_000;
  const outputCost = (input.outputPerMTok * outputTokens) / 1_000_000;
  return inputCost + outputCost;
}
