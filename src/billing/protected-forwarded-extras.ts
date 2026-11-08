/**
 * Protected-profile audit of request.extra keys that admitted connectors
 * forward into the provider body.
 *
 * Every forwarded key must be one of:
 * - counted into the input UTF-8 upper bound;
 * - refused before dispatch when present (or when a required kill-switch is absent);
 * - shown not to add input tokens or non-token charges (sampling / stream flags).
 *
 * Perplexity decision (round 6): keep the class admitted (fence + max_tokens),
 * but refuse protected prepares that can bill per-request search fees. Those fees
 * are not catalogue token rates, so the hold cannot cover them. Search is off
 * only when `disable_search: true` and no search-enabling extras are present.
 * `response_format` schemas are counted as UTF-8 JSON into the input bound.
 */

export type ProtectedExtraDisposition = 'neutral' | 'count_utf8' | 'refuse_when_present';

export interface ProtectedForwardedExtraRecord {
  className: string;
  /** Keys `buildRequestBody` may copy from `request.extra` (source-verified). */
  forwardedExtraKeys: readonly string[];
  disposition: Readonly<Record<string, ProtectedExtraDisposition>>;
  /**
   * When set, protected prepare requires this boolean extra to be strictly true
   * (Perplexity search kill-switch).
   */
  requireExtraTrue?: string;
}

const NEUTRAL_SAMPLING = {
  temperature: 'neutral',
  top_p: 'neutral',
  top_k: 'neutral',
  seed: 'neutral',
  stream: 'neutral',
  stop: 'neutral',
  stream_mode: 'neutral',
  reasoning_effort: 'neutral',
  language_preference: 'neutral',
} as const satisfies Record<string, ProtectedExtraDisposition>;

/**
 * Exhaustive disposition table for admitted classes with `forwardsMaxTokens: true`.
 * Keep in sync with each connector's `buildRequestBody`.
 */
export const PROTECTED_FORWARDED_EXTRA_RECORDS: readonly ProtectedForwardedExtraRecord[] = [
  {
    className: 'AzureOpenAiConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice'],
    disposition: {
      max_tokens: 'neutral', // output cap handled separately
      temperature: 'neutral',
      top_p: 'neutral',
      tools: 'count_utf8',
      tool_choice: 'count_utf8',
    },
  },
  {
    className: 'CloudflareWorkersAiConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p', 'top_k', 'seed'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
      top_k: 'neutral',
      seed: 'neutral',
    },
  },
  {
    className: 'FireworksConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
    },
  },
  {
    className: 'GrokConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
    },
  },
  {
    className: 'GroqConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
    },
  },
  {
    className: 'HuggingFaceConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
    },
  },
  {
    className: 'MistralConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
    },
  },
  {
    className: 'OpenModelConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
    },
  },
  {
    className: 'OpenRouterConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
    },
  },
  {
    className: 'OrqConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
    },
  },
  {
    className: 'PerplexityConnector',
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
    disposition: {
      max_tokens: 'neutral',
      ...NEUTRAL_SAMPLING,
      disable_search: 'neutral',
      response_format: 'count_utf8',
      web_search_options: 'refuse_when_present',
      search_mode: 'refuse_when_present',
      return_images: 'refuse_when_present',
      return_related_questions: 'refuse_when_present',
      enable_search_classifier: 'refuse_when_present',
      search_domain_filter: 'refuse_when_present',
      search_language_filter: 'refuse_when_present',
      search_recency_filter: 'refuse_when_present',
      search_after_date_filter: 'refuse_when_present',
      search_before_date_filter: 'refuse_when_present',
      last_updated_before_filter: 'refuse_when_present',
      last_updated_after_filter: 'refuse_when_present',
      image_format_filter: 'refuse_when_present',
      image_domain_filter: 'refuse_when_present',
    },
    requireExtraTrue: 'disable_search',
  },
  {
    className: 'TogetherConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p'],
    disposition: {
      max_tokens: 'neutral',
      temperature: 'neutral',
      top_p: 'neutral',
    },
  },
] as const;

const BY_CLASS: ReadonlyMap<string, ProtectedForwardedExtraRecord> = new Map(
  PROTECTED_FORWARDED_EXTRA_RECORDS.map((r) => [r.className, r]),
);

function utf8JsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    // Unserializable payloads cannot be bounded — caller must refuse.
    return -1;
  }
}

export type ProtectedForwardedExtrasResult =
  | { ok: true; countedInputBytes: number }
  | { ok: false; message: string };

/**
 * Assess forwarded extras for a protected prepare. Unknown class → no-op
 * (non-Base test doubles / classes without a forwardsMaxTokens body).
 */
export function assessProtectedForwardedExtras(params: {
  connectorClassName: string | null | undefined;
  extra?: Record<string, unknown> | null;
}): ProtectedForwardedExtrasResult {
  const record = params.connectorClassName
    ? BY_CLASS.get(params.connectorClassName)
    : undefined;
  if (!record) {
    return { ok: true, countedInputBytes: 0 };
  }

  const extra = params.extra ?? {};

  if (record.requireExtraTrue) {
    const flag = extra[record.requireExtraTrue];
    if (flag !== true) {
      return {
        ok: false,
        message: `Protected prepare for ${record.className} requires ${record.requireExtraTrue}=true so unpriced non-token fees cannot apply.`,
      };
    }
  }

  let countedInputBytes = 0;
  for (const key of record.forwardedExtraKeys) {
    if (!Object.prototype.hasOwnProperty.call(extra, key)) continue;
    const value = extra[key];
    if (value === undefined) continue;
    const disposition = record.disposition[key];
    if (disposition == null) {
      return {
        ok: false,
        message: `Protected prepare refuses unreviewed forwarded extra '${key}' for ${record.className}.`,
      };
    }
    if (disposition === 'refuse_when_present') {
      return {
        ok: false,
        message: `Protected prepare refuses forwarded extra '${key}' for ${record.className} (unpriced input or non-token fee).`,
      };
    }
    if (disposition === 'count_utf8') {
      const bytes = utf8JsonBytes(value);
      if (bytes < 0) {
        return {
          ok: false,
          message: `Protected prepare cannot UTF-8-bound forwarded extra '${key}' for ${record.className}.`,
        };
      }
      countedInputBytes += bytes;
    }
  }

  return { ok: true, countedInputBytes };
}
