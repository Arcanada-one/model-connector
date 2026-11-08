/**
 * Explicit per-class admission for the protected Lab dispatch fence.
 *
 * Inheritance of a capability boolean is not proof that a subclass's execute
 * path calls `__beforeProviderFetch`. Only constructors listed here are
 * admitted. Stage A admits BaseApiConnector subclasses that inherit
 * `BaseApiConnector.execute` without overriding it. Subclasses that override
 * `execute` (even when they call `super.execute`) stay refused until
 * individually reviewed and listed.
 */

export type FenceAdmissionDecision = 'admitted' | 'refused';

export interface FenceAdmissionRecord {
  className: string;
  overridesExecute: boolean;
  callsSuperExecute: boolean | null;
  decision: FenceAdmissionDecision;
  reason: string;
}

/**
 * Exhaustive BaseApiConnector subclass inventory as of the Stage A round-3
 * review (2026-11-08). Keep in sync when adding a connector class.
 */
export const PROTECTED_DISPATCH_FENCE_DECISIONS: readonly FenceAdmissionRecord[] = [
  // --- inherit BaseApiConnector.execute (hook path) — admitted ---
  {
    className: 'AzureOpenAiConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'CerebrasConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'CloudflareWorkersAiConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'EmbeddingConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'FireworksConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'GrokConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'GroqConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'HuggingFaceConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'MistralConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'OllamaCloudConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'OllamaConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'OpenAiConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'OpenModelConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'OpenRouterConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'OrqConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'PerplexityConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },
  {
    className: 'TogetherConnector',
    overridesExecute: false,
    callsSuperExecute: null,
    decision: 'admitted',
    reason: 'Inherits BaseApiConnector.execute; provider fetch is fenced.',
  },

  // --- overrides execute (even with super.execute) — refused until reviewed ---
  {
    className: 'AnthropicConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'CohereConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'DeepSeekConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'GeminiApiConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'JevConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'JinaAiConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'PineconeInferenceConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'VertexGenerativeConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
  {
    className: 'VoyageAiConnector',
    overridesExecute: true,
    callsSuperExecute: true,
    decision: 'refused',
    reason: 'Overrides execute; not individually admitted for protected fence.',
  },
] as const;

export const PROTECTED_DISPATCH_FENCE_ADMITTED_CLASSES: ReadonlySet<string> = new Set(
  PROTECTED_DISPATCH_FENCE_DECISIONS.filter((d) => d.decision === 'admitted').map(
    (d) => d.className,
  ),
);

export function isProtectedDispatchFenceClassAdmitted(
  constructorName: string | undefined | null,
): boolean {
  if (!constructorName) return false;
  return PROTECTED_DISPATCH_FENCE_ADMITTED_CLASSES.has(constructorName);
}
