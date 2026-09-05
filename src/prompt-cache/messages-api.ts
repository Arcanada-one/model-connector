// AUP-CACHE-006 (enforce0) — raw Messages API passthrough for cache-aware agents.
//
// CONN's ConnectorRequest flattens `system` to a string and knows one user
// message: a caller could not place a single cache_control breakpoint through
// it, so every request through the gateway was SYSTEM_NOT_BLOCKS by
// construction (found while writing the policy; recorded in the receipt). A
// cache-aware agent therefore hands the Anthropic connector the Messages API
// fields verbatim under `extra.messages_api`; the connector copies exactly the
// allow-listed keys and refuses any other key — it never drops or rewrites one.

export const MESSAGES_API_PASSTHROUGH_KEYS: ReadonlySet<string> = new Set([
  'tools',
  'tool_choice',
  'system',
  'messages',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
  'thinking',
  'output_config',
  'service_tier',
]);

export class MessagesApiValidationError extends Error {
  constructor(reason: string) {
    super(`extra.messages_api is invalid: ${reason}`);
    this.name = 'MessagesApiValidationError';
  }
}

export interface PromptCacheRequestFields {
  readonly session_id?: string;
  readonly session_epoch?: string;
  readonly prefix_hash?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate `extra.messages_api`; returns the copied allow-listed fields. */
export function readMessagesApi(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const raw = extra?.messages_api;
  if (raw === undefined) return null;
  if (!isRecord(raw)) throw new MessagesApiValidationError('it is not an object');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!MESSAGES_API_PASSTHROUGH_KEYS.has(key)) {
      throw new MessagesApiValidationError(`${JSON.stringify(key)} is not a passthrough field`);
    }
    out[key] = raw[key];
  }
  if (!Array.isArray(out.messages) || out.messages.length === 0) {
    throw new MessagesApiValidationError('messages must be a non-empty array');
  }
  return out;
}

/** Validate `extra.prompt_cache` (session identity the caller asserts; the tenant never comes from here). */
export function readPromptCacheFields(
  extra: Record<string, unknown> | undefined,
): PromptCacheRequestFields {
  const raw = extra?.prompt_cache;
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new MessagesApiValidationError('extra.prompt_cache is not an object');
  const out: { session_id?: string; session_epoch?: string; prefix_hash?: string } = {};
  for (const key of ['session_id', 'session_epoch', 'prefix_hash'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
      throw new MessagesApiValidationError(
        `extra.prompt_cache.${key} must be a non-empty string (max 200 chars)`,
      );
    }
    out[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!['session_id', 'session_epoch', 'prefix_hash'].includes(key)) {
      throw new MessagesApiValidationError(`extra.prompt_cache.${key} is not a known field`);
    }
  }
  return out;
}
