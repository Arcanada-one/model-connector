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
 * non-Base fenced connectors; tests may use the vitest-only admission seam.
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
  // --- inherit BaseApiConnector.execute (hook path) — admitted ---
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
      'deployment metadata — Azure deployment names are operator-chosen.',
  },
  {
    className: 'CerebrasConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: ['max_completion_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason:
      'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_completion_tokens only — not max_tokens.',
  },
  {
    className: 'CloudflareWorkersAiConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p', 'top_k', 'seed'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
  },
  {
    className: 'EmbeddingConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'admitted',
    reason:
      'Inherits BaseApiConnector.execute; provider fetch is fenced. Embedding body has no max_tokens.',
  },
  {
    className: 'FireworksConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
  },
  {
    className: 'GrokConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
  },
  {
    className: 'GroqConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
  },
  {
    className: 'HuggingFaceConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
  },
  {
    className: 'MistralConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
  },
  {
    className: 'OllamaCloudConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'admitted',
    reason:
      'Inherits BaseApiConnector.execute; provider fetch is fenced. Options bag only — does not forward max_tokens.',
  },
  {
    className: 'OllamaConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: [],
    decision: 'admitted',
    reason:
      'Inherits BaseApiConnector.execute; provider fetch is fenced. Options bag only — does not forward max_tokens.',
  },
  {
    className: 'OpenAiConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: false,
    forwardedExtraKeys: ['max_output_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason:
      'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_output_tokens only — not max_tokens.',
  },
  {
    className: 'OpenModelConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature'],
    decision: 'admitted',
    reason:
      'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens (defaulted when absent).',
  },
  {
    className: 'OpenRouterConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
  },
  {
    className: 'OrqConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
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
    decision: 'admitted',
    reason:
      'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens via documented options. Protected prepare requires disable_search=true; search extras refused; response_format counted as UTF-8.',
  },
  {
    className: 'TogetherConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    forwardsMaxTokens: true,
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced. Forwards max_tokens.',
  },

  // --- overrides execute (even with super.execute) — refused until reviewed ---
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

export const PROTECTED_DISPATCH_FENCE_ADMITTED_CLASSES: ReadonlySet<string> = new Set(
  PROTECTED_DISPATCH_FENCE_DECISIONS.filter((d) => d.decision === 'admitted').map(
    (d) => d.className,
  ),
);

const FORWARDS_MAX_TOKENS_BY_CLASS: ReadonlyMap<string, boolean> = new Map(
  PROTECTED_DISPATCH_FENCE_DECISIONS.map((d) => [d.className, d.forwardsMaxTokens]),
);

export function isProtectedDispatchFenceClassAdmitted(
  constructorName: string | undefined | null,
): boolean {
  if (!constructorName) return false;
  return PROTECTED_DISPATCH_FENCE_ADMITTED_CLASSES.has(constructorName);
}

export function classForwardsProtectedMaxTokens(
  constructorName: string | undefined | null,
): boolean {
  if (!constructorName) return false;
  return FORWARDS_MAX_TOKENS_BY_CLASS.get(constructorName) === true;
}

/**
 * Production non-Base fence admissions: empty. No non-Base connector has an
 * independently verified pre-send fence today.
 */
export const PROTECTED_NON_BASE_FENCE_ADMISSIONS: ReadonlySet<string> = new Set();

interface TestOnlyNonBaseAdmission {
  forwardsMaxTokens: boolean;
}

/** Vitest-only map — never populated from production configuration. */
const testOnlyNonBaseAdmissions = new Map<string, TestOnlyNonBaseAdmission>();

function assertVitestOnlySeam(action: string): void {
  if (process.env.VITEST !== 'true') {
    throw new Error(`Protected non-Base fence ${action} is test-only (VITEST!==true).`);
  }
}

/**
 * Test-only admission for a non-Base IConnector double. Unreachable unless
 * Vitest set `VITEST=true`. Production configuration cannot enable this path.
 */
export function __testOnlyAdmitNonBaseProtectedFence(
  connectorName: string,
  opts: { forwardsMaxTokens?: boolean } = {},
): void {
  assertVitestOnlySeam('admit');
  testOnlyNonBaseAdmissions.set(connectorName, {
    forwardsMaxTokens: opts.forwardsMaxTokens === true,
  });
}

export function __testOnlyClearNonBaseProtectedFence(): void {
  assertVitestOnlySeam('clear');
  testOnlyNonBaseAdmissions.clear();
}

export function isNonBaseProtectedFenceAdmitted(connectorName: string): boolean {
  if (PROTECTED_NON_BASE_FENCE_ADMISSIONS.has(connectorName)) return true;
  if (process.env.VITEST === 'true' && testOnlyNonBaseAdmissions.has(connectorName)) {
    return true;
  }
  return false;
}

export function nonBaseForwardsProtectedMaxTokens(connectorName: string): boolean {
  if (PROTECTED_NON_BASE_FENCE_ADMISSIONS.has(connectorName)) {
    // Production set is empty; if a future reviewed entry is added it must
    // carry its own forwarding record. Fail closed until then.
    return false;
  }
  if (process.env.VITEST === 'true') {
    return testOnlyNonBaseAdmissions.get(connectorName)?.forwardsMaxTokens === true;
  }
  return false;
}
