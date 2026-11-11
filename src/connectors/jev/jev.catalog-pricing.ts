/**
 * CONN-JEV-05 — catalog pricing for typesafe-jev without invention.
 *
 * Sources (never invented literals):
 * - direct: machine fields from an ARCA-JEV-01-shaped `GET /v1/models` probe
 *   payload. When the probe is absent or carries no price fields, pricing stays
 *   `null` and the provenance is recorded as `direct-models-unconfirmed`.
 * - openrouter: measured `/api/v1/models` fixture (`pricing.prompt =
 *   "0.000000042"` → `normalizePerMTokPrice` → 0.042). Marked fixture, not a
 *   live probe claim.
 * - cloudflare: no machine token price → `null` (pricingSource `null`).
 *
 * `contextWindow` floor is 32_000 for every route model (route minimum).
 *
 * Route model ids follow JEV-DECISION-LAYER-SPEC §11.2. Availability for
 * openrouter/cloudflare stays false until their env keys are present — this
 * module does not invent live success (CONN-JEV-02 stubs remain honest here;
 * JevRoute transport lives in jev.routes.ts and is kept separate from pricing).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ModelPricing, normalizePerMTokPrice } from '../dto/catalog.dto';
import { ProviderModelMeta } from '../interfaces/connector.interface';

/** Honest route minimum from JEV-DECISION-LAYER-SPEC §11.2 / CONN-JEV-05 (г). */
export const JEV_CONTEXT_WINDOW_MIN = 32_000;

export type JevPriceRouteId = 'direct' | 'openrouter' | 'cloudflare';

export type JevPriceProvenance =
  | 'direct-models-unconfirmed'
  | 'direct-models-probe'
  | 'openrouter-models-fixture'
  | 'null';

export interface JevCatalogPriceRow {
  route: JevPriceRouteId;
  model: string;
  available: boolean;
  pricing: ModelPricing | null;
  contextWindow: number;
  provenance: JevPriceProvenance;
}

/** Env keys that gate catalog availability for stub routes (no invented live). */
export interface JevCatalogPriceEnv {
  TYPESAFE_API_KEY?: string;
  TYPESAFE_JEV_API_KEY?: string;
  TYPESAFE_JEV_OPENROUTER_API_KEY?: string;
  TYPESAFE_JEV_CLOUDFLARE_API_TOKEN?: string;
  TYPESAFE_JEV_CLOUDFLARE_ACCOUNT_ID?: string;
  TYPESAFE_JEV_ROUTES_ENABLED?: string;
}

/** Measured OpenRouter `/api/v1/models` fragment for `typesafe/jev-1.13` (CONN-JEV-05). */
export const OPENROUTER_TYPESAFE_JEV_MODELS_FIXTURE = {
  _fixture_provenance:
    'CONN-JEV-05 measured OpenRouter /api/v1/models fragment for typesafe/jev-1.13; ' +
    'pricing.prompt="0.000000042" from JEV-DECISION-LAYER-SPEC §2.4 / §11.2. ' +
    'Not a live probe claim — fixture-marked for catalog tests.',
  data: [
    {
      id: 'typesafe/jev-1.13',
      context_length: 32_000,
      pricing: { prompt: '0.000000042', completion: '0' },
      top_provider: { context_length: 32_000, max_completion_tokens: null },
    },
    {
      id: '~typesafe/jev-latest',
      context_length: 32_000,
      pricing: { prompt: '0.000000042', completion: '0' },
      top_provider: { context_length: 32_000, max_completion_tokens: null },
    },
  ],
} as const;

/** Spec §11.2 model ids per transport — catalog-facing, not an invented live API. */
const ROUTE_MODELS: Record<
  JevPriceRouteId,
  {
    models: readonly string[];
    pricingSource: 'direct-models-unconfirmed' | 'openrouter-models' | 'null';
  }
> = {
  direct: {
    models: ['jev-latest', 'jev-1.13.0', 'jev-preview'],
    pricingSource: 'direct-models-unconfirmed',
  },
  openrouter: {
    models: ['typesafe/jev-1.13', '~typesafe/jev-latest'],
    pricingSource: 'openrouter-models',
  },
  cloudflare: {
    models: ['typesafe/jev'],
    pricingSource: 'null',
  },
};

type OpenRouterModelsShape = {
  data?: Array<{
    id?: string;
    context_length?: number | null;
    pricing?: { prompt?: string | null; completion?: string | null } | null;
    top_provider?: { context_length?: number | null; max_completion_tokens?: number | null } | null;
  }>;
};

type DirectModelRow = {
  id?: string;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
    input?: string | number | null;
    output?: string | number | null;
  } | null;
  context_length?: number | null;
  contextWindow?: number | null;
};

type DirectModelsShape = {
  data?: DirectModelRow[];
  models?: DirectModelRow[];
};

function trim(value: string | undefined): string {
  return (value ?? '').trim();
}

function enabledRoutes(env: JevCatalogPriceEnv): Set<JevPriceRouteId> {
  const raw = trim(env.TYPESAFE_JEV_ROUTES_ENABLED);
  const parts = (raw || 'direct')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = new Set<JevPriceRouteId>();
  for (const p of parts) {
    if (p === 'direct' || p === 'openrouter' || p === 'cloudflare') out.add(p);
  }
  if (out.size === 0) out.add('direct');
  return out;
}

function routeKeyed(route: JevPriceRouteId, env: JevCatalogPriceEnv): boolean {
  if (route === 'direct') {
    return Boolean(trim(env.TYPESAFE_JEV_API_KEY) || trim(env.TYPESAFE_API_KEY));
  }
  if (route === 'openrouter') {
    return Boolean(trim(env.TYPESAFE_JEV_OPENROUTER_API_KEY));
  }
  return Boolean(
    trim(env.TYPESAFE_JEV_CLOUDFLARE_API_TOKEN) && trim(env.TYPESAFE_JEV_CLOUDFLARE_ACCOUNT_ID),
  );
}

function pricingFromOpenRouterEntry(entry: {
  pricing?: { prompt?: string | null; completion?: string | null } | null;
}): ModelPricing | null {
  const inputPerMTok = normalizePerMTokPrice(entry.pricing?.prompt);
  const outputPerMTok = normalizePerMTokPrice(entry.pricing?.completion);
  if (inputPerMTok === null && outputPerMTok === null) return null;
  return { inputPerMTok, outputPerMTok, unit: 'per_1m_tokens' };
}

/** Parse an OpenRouter `/api/v1/models` JSON body into id → pricing. */
export function pricingMapFromOpenRouterModels(
  json: unknown,
): Map<string, { pricing: ModelPricing | null; contextWindow: number | null }> {
  const out = new Map<string, { pricing: ModelPricing | null; contextWindow: number | null }>();
  const body = json as OpenRouterModelsShape;
  if (!Array.isArray(body?.data)) return out;
  for (const entry of body.data) {
    if (typeof entry?.id !== 'string') continue;
    const contextWindow =
      (typeof entry.top_provider?.context_length === 'number'
        ? entry.top_provider.context_length
        : null) ?? (typeof entry.context_length === 'number' ? entry.context_length : null);
    out.set(entry.id, { pricing: pricingFromOpenRouterEntry(entry), contextWindow });
  }
  return out;
}

/**
 * Parse an ARCA-JEV-01-shaped direct `GET /v1/models` probe.
 * Returns prices only when machine fields are present — never invents.
 */
export function pricingMapFromDirectModelsProbe(
  json: unknown,
): Map<string, { pricing: ModelPricing | null; contextWindow: number | null }> {
  const out = new Map<string, { pricing: ModelPricing | null; contextWindow: number | null }>();
  const body = json as DirectModelsShape;
  const rows = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : null;
  if (!rows) return out;
  for (const entry of rows) {
    if (typeof entry?.id !== 'string') continue;
    const raw = entry.pricing;
    const inputPerMTok =
      normalizePerMTokPrice(raw?.prompt) ?? normalizePerMTokPrice(raw?.input) ?? null;
    const outputPerMTok =
      normalizePerMTokPrice(raw?.completion) ?? normalizePerMTokPrice(raw?.output) ?? null;
    const pricing =
      inputPerMTok !== null || outputPerMTok !== null
        ? { inputPerMTok, outputPerMTok, unit: 'per_1m_tokens' as const }
        : null;
    const contextWindow =
      typeof entry.context_length === 'number'
        ? entry.context_length
        : typeof entry.contextWindow === 'number'
          ? entry.contextWindow
          : null;
    out.set(entry.id, { pricing, contextWindow });
  }
  return out;
}

const openRouterFixtureMap = pricingMapFromOpenRouterModels(OPENROUTER_TYPESAFE_JEV_MODELS_FIXTURE);

/**
 * Load the on-disk OpenRouter typesafe fixture when present; otherwise the
 * in-module measured fragment. Always fixture-marked — never a live claim.
 */
export function loadOpenRouterTypesafePricingFixture(): Map<
  string,
  { pricing: ModelPricing | null; contextWindow: number | null }
> {
  try {
    const path = resolve(
      __dirname,
      '../../../test/fixtures/connectors/openrouter-typesafe-jev-models.fixture.json',
    );
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const map = pricingMapFromOpenRouterModels(parsed);
    if (map.size > 0) return map;
  } catch {
    /* fall through to in-module fragment */
  }
  return openRouterFixtureMap;
}

export interface BuildJevCatalogPriceRowsInput {
  env?: JevCatalogPriceEnv;
  /** ARCA-JEV-01 probe JSON for direct `/v1/models`, or null when unconfirmed. */
  directModelsProbe?: unknown | null;
  openRouterModels?: Map<string, { pricing: ModelPricing | null; contextWindow: number | null }>;
}

/** Build priced catalog rows for every known JEV route model id. */
export function buildJevCatalogPriceRows(
  input: BuildJevCatalogPriceRowsInput = {},
): JevCatalogPriceRow[] {
  const env = input.env ?? (process.env as JevCatalogPriceEnv);
  const enabled = enabledRoutes(env);
  const directProbe = input.directModelsProbe
    ? pricingMapFromDirectModelsProbe(input.directModelsProbe)
    : null;
  const openRouter = input.openRouterModels ?? loadOpenRouterTypesafePricingFixture();
  const rows: JevCatalogPriceRow[] = [];

  for (const route of Object.keys(ROUTE_MODELS) as JevPriceRouteId[]) {
    const def = ROUTE_MODELS[route];
    const available = enabled.has(route) && routeKeyed(route, env);
    for (const model of def.models) {
      if (def.pricingSource === 'openrouter-models') {
        const hit = openRouter.get(model);
        rows.push({
          route,
          model,
          available,
          pricing: hit?.pricing ?? null,
          contextWindow:
            Math.max(JEV_CONTEXT_WINDOW_MIN, hit?.contextWindow ?? 0) || JEV_CONTEXT_WINDOW_MIN,
          provenance: 'openrouter-models-fixture',
        });
        continue;
      }
      if (def.pricingSource === 'direct-models-unconfirmed') {
        const hit = directProbe?.get(model);
        const hasMachinePrice = hit?.pricing != null;
        rows.push({
          route,
          model,
          available,
          pricing: hasMachinePrice ? hit!.pricing : null,
          contextWindow:
            Math.max(JEV_CONTEXT_WINDOW_MIN, hit?.contextWindow ?? 0) || JEV_CONTEXT_WINDOW_MIN,
          provenance: hasMachinePrice ? 'direct-models-probe' : 'direct-models-unconfirmed',
        });
        continue;
      }
      rows.push({
        route,
        model,
        available,
        pricing: null,
        contextWindow: JEV_CONTEXT_WINDOW_MIN,
        provenance: 'null',
      });
    }
  }
  return rows;
}

/** ProviderModelMeta list for `getCapabilities()` — one row per route model. */
export function buildJevCapabilityModelMeta(
  input: BuildJevCatalogPriceRowsInput = {},
): ProviderModelMeta[] {
  return buildJevCatalogPriceRows(input).map((row) => ({
    id: row.model,
    modality: 'decision' as const,
    pricing: row.pricing,
    contextWindow: row.contextWindow,
    ...(row.pricing && row.pricing.inputPerMTok === 0 && row.pricing.outputPerMTok === 0
      ? { free: true }
      : {}),
  }));
}

/** Per-model availability map for connectors.service intersection. */
export function jevRouteAvailabilityMap(
  env: JevCatalogPriceEnv = process.env as JevCatalogPriceEnv,
): Map<string, boolean> {
  return new Map(buildJevCatalogPriceRows({ env }).map((row) => [row.model, row.available]));
}

/**
 * Catalog honesty invariant (CONN-JEV-05 negative control):
 * a routable paid model with `available:true` must carry a machine price.
 *
 * Allowed null pricing while available:
 * - `direct-models-unconfirmed` (AC-22 — probe has not confirmed a price)
 * - `null` provenance (Cloudflare — no token tariff exists)
 */
export function assertRoutableAvailablePriceHonesty(rows: JevCatalogPriceRow[]): {
  ok: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  for (const row of rows) {
    if (!row.available) continue;
    if (row.pricing != null) continue;
    if (row.provenance === 'direct-models-unconfirmed' || row.provenance === 'null') continue;
    violations.push(`${row.route}/${row.model}: available:true without machine price`);
  }
  return { ok: violations.length === 0, violations };
}
