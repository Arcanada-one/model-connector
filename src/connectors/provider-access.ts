// CONN-0244 — per-provider access model. Two INDEPENDENT capabilities per provider:
//   read — the provider's models are visible in the catalog (list / prices / capabilities)
//   use  — MC routes traffic through the provider (cascade + /execute + any health-routing)
//
// This replaces the all-or-nothing OPENMODEL_ENABLED coupling that let a paid provider be
// silently used by the "free" cascade. A provider can now be READ-only (visible but not
// routable) — e.g. OpenModel, which the operator cannot fund but wants kept in the catalog.
//
// The model is GENERIC (not OpenModel-specific): any provider name can be assigned a level.

export interface ProviderAccess {
  /** Models are visible in the catalog. */
  read: boolean;
  /** MC will route traffic through this provider (cascade / execute / health-routing). */
  use: boolean;
}

/** Backward-compatible default: a provider not listed in PROVIDER_ACCESS is fully enabled. */
export const DEFAULT_PROVIDER_ACCESS: ProviderAccess = { read: true, use: true };

/**
 * Parse the PROVIDER_ACCESS env into a map. Format: `name:level,name:level,...`
 * level tokens:
 *   `use`  → { read: true,  use: true  }  (fully enabled; also the token-less default)
 *   `read` → { read: true,  use: false }  (visible in catalog, NOT routable)
 *   `none` → { read: false, use: false }  (hidden entirely)
 * Unknown levels and empty names are ignored (fail-open to DEFAULT_PROVIDER_ACCESS).
 */
export function parseProviderAccess(csv?: string): Map<string, ProviderAccess> {
  const map = new Map<string, ProviderAccess>();
  if (!csv || csv.trim() === '') return map;
  for (const raw of csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const colon = raw.indexOf(':');
    const name = (colon === -1 ? raw : raw.slice(0, colon)).trim();
    const level = (colon === -1 ? 'use' : raw.slice(colon + 1).trim()).toLowerCase() || 'use';
    if (!name) continue;
    if (level === 'none') map.set(name, { read: false, use: false });
    else if (level === 'read') map.set(name, { read: true, use: false });
    else if (level === 'use') map.set(name, { read: true, use: true });
    // unknown level → skip (leaves the provider at DEFAULT_PROVIDER_ACCESS)
  }
  return map;
}

/** Resolve a provider's access, falling back to the fully-enabled default. */
export function resolveProviderAccess(
  map: Map<string, ProviderAccess>,
  name: string,
): ProviderAccess {
  return map.get(name) ?? DEFAULT_PROVIDER_ACCESS;
}
