// AUP-CACHE-006 (enforce0) — routing context for the prompt-cache policy.
//
// ConnectorsService.execute() (the CONN-0244 single choke point) enters this
// context with the caller's API-key id before any connector runs, so the
// policy evaluator learns WHO is sending from the routing layer — never from
// the prompt, never from what the request says about itself (the CACHE-003
// design note's rule: identity from routing context, prefix_hash from bytes).
// Same mechanism as the CONN-1665 provider-key override context; like it, the
// context does not survive the BullMQ queue path.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface PromptCacheRequestContext {
  /** The tenant boundary of the gateway = the calling API key's id. */
  readonly tenantId: string;
}

export const promptCacheContext = new AsyncLocalStorage<PromptCacheRequestContext>();

/** The calling tenant, or null when no routing context is active. */
export function getPromptCacheTenant(): string | null {
  return promptCacheContext.getStore()?.tenantId ?? null;
}
