// CONN-1665 — per-request provider-key override context.
//
// ConnectorsService.execute() wraps the ENTIRE retry loop in
// `providerKeyContext.run(...)` when the caller's key policy names a dedicated
// env key for the target provider, so every attempt (including output-guard
// wrapped ones) sees the override. The context is NEVER handed off through the
// BullMQ queue path — AsyncLocalStorage does not survive serialization, and the
// queue path bypasses every gate anyway (see enqueue-dead-path.spec.ts).
//
// Consumers (override-capable connectors only, see KEY_OVERRIDE_CAPABLE in
// policy.schema.ts) MUST check `store.provider === '<their name>'` before using
// `store.apiKey` — a failover/cascade hop to a different provider inside the
// same async context must not leak another provider's key.
//
// Cohere's existing private AsyncLocalStorage (redaction context) is unrelated
// and intentionally untouched.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface ProviderKeyOverride {
  /** Connector name the override is scoped to (e.g. 'openrouter'). */
  provider: string;
  /** The resolved API key VALUE (read from process.env[<policy env name>]). */
  apiKey: string;
}

export const providerKeyContext = new AsyncLocalStorage<ProviderKeyOverride>();

/**
 * The override key for `provider`, or null when no override context is active
 * or the active context targets a different provider.
 */
export function getProviderKeyOverride(provider: string): string | null {
  const store = providerKeyContext.getStore();
  if (!store || store.provider !== provider) return null;
  return store.apiKey;
}
