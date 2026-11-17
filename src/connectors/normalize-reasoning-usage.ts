/**
 * #105 — keep `reasoningOutputTokens` a subset of `outputTokens`.
 *
 * Documented contract (`connector.interface.ts`): reasoning is "Included in
 * `outputTokens`" and billed at the output rate via `measureCostUsd`'s
 * `outputTokens * outputPerMTok`. Some providers report reasoning as ADDITIVE
 * (completion_tokens = visible answer only); production rows then store
 * `reasoningOutputTokens > outputTokens` and those tokens are billed to nobody.
 *
 * Default detection: when `reasoning > outputTokens`, treat the report as
 * additive and fold (`outputTokens += reasoning`). Already-subset OpenAI-
 * compatible reports (`reasoning <= completion`) are left unchanged so we do
 * not double-count.
 *
 * Codex CLI always reports reasoning as additive (`total = in+out+reasoning`)
 * even when reasoning is smaller than visible output — pass `additive: true`
 * for that lane.
 */

export function normalizeReasoningSubset(input: {
  outputTokens: number;
  reasoningOutputTokens?: number;
  /**
   * Provider always reports reasoning as additive (Codex CLI). When set,
   * reasoning is folded into outputTokens whenever it is a positive count,
   * not only when it exceeds outputTokens.
   */
  additive?: boolean;
}): { outputTokens: number; reasoningOutputTokens?: number } {
  const outputTokens =
    typeof input.outputTokens === 'number' && Number.isFinite(input.outputTokens)
      ? Math.max(0, input.outputTokens)
      : 0;

  if (input.reasoningOutputTokens === undefined) {
    return { outputTokens };
  }

  const reasoning =
    typeof input.reasoningOutputTokens === 'number' && Number.isFinite(input.reasoningOutputTokens)
      ? Math.max(0, input.reasoningOutputTokens)
      : 0;

  const mustFold = input.additive === true ? reasoning > 0 : reasoning > outputTokens;
  if (mustFold) {
    return {
      outputTokens: outputTokens + reasoning,
      reasoningOutputTokens: reasoning,
    };
  }

  return { outputTokens, reasoningOutputTokens: reasoning };
}
