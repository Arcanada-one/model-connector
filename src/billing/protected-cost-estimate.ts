/**
 * Protected-profile-only hard cost bound.
 *
 * Deliberately separate from {@link estimateCostUsd}: legacy / non-protected
 * traffic keeps the chars/4 + 2000-output-floor heuristic unchanged.
 *
 * The protected hold must be a true upper bound:
 * - input tokens: UTF-8 byte length of the final effective request parts
 *   (each byte is an upper bound of ≥1 token under any real tokenizer),
 *   plus a class-specific chat-framing allowance when one is provider-grounded;
 * - output tokens: the caller `max_tokens` the admitted connector forwards;
 * - money: round UP to ledger precision (6 decimal places).
 */

import type { ContentBlock } from '../connectors/interfaces/connector.interface';

/** Ledger precision used by BillingService hold SQL (`toFixed(6)`). */
export const PROTECTED_HOLD_DECIMALS = 6;

/**
 * Azure OpenAI chat-completions structural tokens per message.
 * Source: Microsoft Learn — "Work with chat completion models"
 * https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/chatgpt
 * (`tokens_per_message = 3` for the gpt-4o / gpt-4.1 / gpt-5 / o-series set).
 */
export const AZURE_CHAT_TOKENS_PER_MESSAGE = 3;

/**
 * Azure OpenAI chat-completions reply-priming tokens added once per request.
 * Same Microsoft Learn page (`num_tokens += 3` after the message loop).
 */
export const AZURE_CHAT_REPLY_PRIMING_TOKENS = 3;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * True when a protected prepare prompt includes an `image_url` ContentBlock.
 * The first protected Lab profile has no provider-grounded image upper bound
 * (Agent-Brain comment 6728415319) — callers must refuse, not guess bytes.
 */
export function protectedPromptContainsImageUrl(
  prompt: string | ContentBlock[] | undefined,
): boolean {
  if (!Array.isArray(prompt)) return false;
  return prompt.some((block) => block?.type === 'image_url');
}

/**
 * True when a protected prepare prompt includes any non-text ContentBlock.
 * Image and other non-text forms are refused before hold/send on the first
 * protected profile (Agent-Brain comment 6728979426).
 */
export function protectedPromptContainsNonTextBlock(
  prompt: string | ContentBlock[] | undefined,
): boolean {
  if (!Array.isArray(prompt)) return false;
  return prompt.some((block) => block?.type !== 'text');
}

function promptUtf8Bytes(prompt: string | ContentBlock[] | undefined): number {
  if (prompt == null) return 0;
  if (typeof prompt === 'string') return utf8Bytes(prompt);
  if (!Array.isArray(prompt)) return 0;
  return prompt.reduce((total, block) => {
    if (block?.type === 'text') return total + utf8Bytes(block.text ?? '');
    // Non-text is refused before this bound is used; never invent an allowance.
    return total;
  }, 0);
}

/**
 * Content-only UTF-8 input upper bound (prompt + system + tool names +
 * response_format). Does **not** include provider chat-message framing
 * (roles, separators, reply priming) — see
 * {@link azureOpenAiChatFramingTokenAllowance}.
 */
export function protectedInputTokenUpperBound(parts: {
  prompt?: string | ContentBlock[];
  systemPrompt?: string;
  tools?: string[];
  /**
   * Server-set `response_format: {type:'json_object'}` (Azure, Mistral,
   * HuggingFace, Cloudflare). Counted into the input bound — small but not
   * assumed negligible.
   */
  responseFormat?: { type: 'json_object' | 'text' };
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
  if (parts.responseFormat?.type === 'json_object') {
    bytes += utf8Bytes(JSON.stringify({ type: 'json_object' }));
  }
  return Math.max(0, bytes);
}

/**
 * Provider-grounded Azure OpenAI chat framing allowance for the whole billed
 * prompt beyond content UTF-8 bytes.
 *
 * Microsoft Learn documents, for the listed chat models, `tokens_per_message = 3`
 * plus a final `+ 3` reply priming, and encodes each message `role` separately.
 * Role strings are absent from {@link protectedInputTokenUpperBound}; count their
 * UTF-8 length as a tokenizer upper bound (byte ≥ token).
 *
 * Source: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/chatgpt
 * (Agent-Brain comment 6728979426 / PR #255 framing disposition).
 */
export function azureOpenAiChatFramingTokenAllowance(parts: { systemPrompt?: string }): number {
  let messageCount = 1; // buildRequestBody always pushes the user message
  let roleBytes = utf8Bytes('user');
  if (typeof parts.systemPrompt === 'string' && parts.systemPrompt.length > 0) {
    messageCount += 1;
    roleBytes += utf8Bytes('system');
  }
  return messageCount * AZURE_CHAT_TOKENS_PER_MESSAGE + AZURE_CHAT_REPLY_PRIMING_TOKENS + roleBytes;
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
 * Round a non-negative USD amount UP to `decimals` places. Never returns a
 * ledger amount strictly less than the raw value (unlike `Number#toFixed` and
 * unlike ceil-after-epsilon-subtraction, which under-ceils values just above a
 * six-decimal boundary — Agent-Brain comment 6728415319).
 *
 * Plain `Math.ceil(amount * scale)` is not enough: IEEE-754 multiplication can
 * land just below an integer for a value that is mathematically above a
 * micro-unit boundary (counterexample: `nextUp(0.000075) * 1e6` ceils to 75).
 * After the initial ceil, bump while the float quotient `c / scale` still
 * compares strictly less than `amount`, so the returned ledger string is never
 * strictly below the raw double.
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
  let c = Math.ceil(amount * scale);
  // Fix-up: if c/scale still compares below amount, multiplication under-shot.
  while (c / scale < amount) {
    c += 1;
  }
  return (c / scale).toFixed(decimals);
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
