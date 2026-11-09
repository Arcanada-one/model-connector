/**
 * Explicit per-class admission for the protected Lab dispatch fence.
 *
 * Inheritance of a capability boolean is not proof that a subclass's execute
 * path calls `__beforeProviderFetch`. Only constructors listed here are
 * admitted. Stage A admits BaseApiConnector subclasses that inherit
 * `BaseApiConnector.execute` without overriding it. Subclasses that override
 * `execute` (even when they call `super.execute`) stay refused until
 * individually reviewed and listed.
 *
 * Non-Base `IConnector` implementations are never admitted by an own
 * `supportsProtectedDispatchFence === true` alone. Production has no verified
 * non-Base fenced connectors; the production admission table is frozen and
 * empty. Specs admit doubles via `vi.spyOn` of the lookup functions — this
 * module exports no mutator.
 *
 * `forwardsMaxTokens` records whether the class's request body builder
 * forwards caller `max_tokens` to the provider (source-verified 2026-11-08).
 * Protected hard-cost holds require this to be true.
 */

export type FenceAdmissionDecision = 'admitted' | 'refused';

export interface FenceAdmissionRecord {
  className: string;
  overridesExecute: boolean;
  callsSuperExecute: boolean | null;
  /** True only when buildRequestBody forwards request.extra.max_tokens. */
  forwardsMaxTokens: boolean;
  /**
   * `request.extra` keys `buildRequestBody` may forward (source-verified).
   * Empty when the class does not forward caller extras, or is refused.
   * Protected prepare dispositions live in `protected-forwarded-extras.ts`.
   */
  forwardedExtraKeys: readonly string[];
  decision: FenceAdmissionDecision;
  reason: string;
}

/**
 * Exhaustive BaseApiConnector subclass inventory as of the Stage A round-3/5
 * review (2026-11-08). Keep in sync when adding a connector class.
 */
export const PROTECTED_DISPATCH_FENCE_DECISIONS: readonly FenceAdmissionRecord[] = [
  // --- inherit BaseApiConnector.execute — Azure admitted; others framing-refused ---
  {
    className: 'AzureOpenAiConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice'],
    decision: 'admitted',
    reason:
      'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens. ' +
      'LIMITATION: protected deployment binding is by server-configured deployment name ' +
      '(options/env equalling the catalogue-priced model), not by provider-verified ' +
      'deployment metadata — Azure deployment names are operator-chosen. ' +
      'Chat framing allowance grounded on Microsoft Learn chat token formula ' +
      '(tokens_per_message=3, reply priming=+3, role UTF-8) only for the ' +
      'documented gpt-4o/gpt-4.1/gpt-5/o-series exact+prefix set; out-of-set ' +
      'models refuse before hold. tools/tool_choice/response_format refuse on ' +
      'protected Azure (Learn message loop does not bound them) — ' +
      'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/chatgpt ' +
      '(PR #255 round 11).',
  },
  {
    className: 'CerebrasConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: ['max_completion_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'CloudflareWorkersAiConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p', 'top_k', 'seed'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'EmbeddingConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'FireworksConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'GrokConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'GroqConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'HuggingFaceConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'MistralConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'OllamaCloudConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'OllamaConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'OpenAiConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: ['max_output_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'OpenModelConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'OpenRouterConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'OrqConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'PerplexityConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: [
      'max_tokens',
      'stream',
      'stop',
      'temperature',
      'top_p',
      'response_format',
      'web_search_options',
      'search_mode',
      'return_images',
      'return_related_questions',
      'enable_search_classifier',
      'disable_search',
      'search_domain_filter',
      'search_language_filter',
      'search_recency_filter',
      'search_after_date_filter',
      'search_before_date_filter',
      'last_updated_before_filter',
      'last_updated_after_filter',
      'image_format_filter',
      'image_domain_filter',
      'stream_mode',
      'reasoning_effort',
      'language_preference',
    ],
    // Agent-Brain Stage A exclusion (PR #255 comment 6728472574): Sonar
    // per-request search / citation / reasoning fees sit outside the token
    // catalogue; caller disable_search is not a proved hard bound. Refuse the
    // whole class from the first protected Lab profile. Legacy unprotected
    // Perplexity traffic is unchanged.
    decision: 'refused',
    reason:
      'Excluded from the first protected Lab profile (PR #255 comment 6728472574): provider search/citation/reasoning fees are outside the token price table; disable_search alone is not a hard ceiling. Legacy unprotected path unchanged.',
  },
  {
    className: 'TogetherConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'refused',
    reason:
      'Refused for the first protected Lab profile (PR #255 comment 6728979426): chat-message / request framing tokens are not covered by a provider-grounded whole-prompt upper bound for this class. Legacy unprotected path unchanged.',
  },
  {
    className: 'AnthropicConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: true,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'CohereConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: true,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'DeepSeekConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: true,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'GeminiApiConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'JevConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'JinaAiConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'PineconeInferenceConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'VertexGenerativeConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'VoyageAiConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
] as const;

const ADMITTED_CLASS_NAMES: readonly string[] = Object.freeze(
  PROTECTED_DISPATCH_FENCE_DECISIONS.filter((d) => d.decision === 'admitted').map(
    (d) => d.className,
  ),
);

export const PROTECTED_DISPATCH_FENCE_ADMITTED_CLASSES: ReadonlySet<string> = new Set(
  ADMITTED_CLASS_NAMES,
);

const FORWARDS_MAX_TOKENS_BY_CLASS: Readonly<Record<string, boolean>> = Object.freeze(
  Object.fromEntries(
    PROTECTED_DISPATCH_FENCE_DECISIONS.map((d) => [d.className, d.forwardsMaxTokens]),
  ),
);

export function isProtectedDispatchFenceClassAdmitted(
  constructorName: string | undefined | null,
): boolean {
  if (!constructorName) return false;
  return ADMITTED_CLASS_NAMES.includes(constructorName);
}

export function classForwardsProtectedMaxTokens(
  constructorName: string | undefined | null,
): boolean {
  if (!constructorName) return false;
  return FORWARDS_MAX_TOKENS_BY_CLASS[constructorName] === true;
}

/**
 * Production non-Base fence admissions: empty and frozen. No non-Base connector
 * has an independently verified pre-send fence today. Specs must not mutate
 * this table — use `vi.spyOn` on `isNonBaseProtectedFenceAdmitted` instead.
 * The lookup reads the frozen array, not a mutable Set backing.
 */
const PRODUCTION_NON_BASE_ADMISSIONS: readonly string[] = Object.freeze([]);

export const PROTECTED_NON_BASE_FENCE_ADMISSIONS: ReadonlySet<string> = new Set(
  PRODUCTION_NON_BASE_ADMISSIONS,
);

export function isNonBaseProtectedFenceAdmitted(connectorName: string): boolean {
  return PRODUCTION_NON_BASE_ADMISSIONS.includes(connectorName);
}

export function nonBaseForwardsProtectedMaxTokens(connectorName: string): boolean {
  // Production non-Base admissions are empty; fail closed. A future reviewed
  // entry must carry its own forwarding record in this function.
  void connectorName;
  return false;
}
