import type { ModelCatalogRow, ModelCatalogUpsert } from './catalog.repository';
import {
  buildDerivedTags,
  isModalityExecutableHere,
  type CatalogModelEntry,
  type ModelModality,
  type ModelPricing,
} from './dto/catalog.dto';

const DEFAULT_PRICE_UNIT = 'USD/1M tokens';

export interface TierInput {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /** Provider-native free flag (e.g. openrouter ':free', groq). NOT the MC-side priceMultiplier. */
  free: boolean;
}

export interface TierResult {
  tier: 'free' | 'paid' | 'unknown';
  free: boolean;
}

/**
 * CONN-0245 — single source of truth for tier/free derivation. Closes the
 * CONN-0244 false-free bug systemically: ONLY real provider tariffs
 * (inputPerMTok/outputPerMTok) and the provider-native free flag are
 * consulted. The MC-side `priceMultiplier` (OPENMODEL_CATALOGUE) is NOT a
 * parameter of this function and must never be threaded into it.
 *
 * 1. Real pricing known (both input & output present): both === 0 -> free;
 *    any > 0 -> paid.
 * 2. Else, provider-native free flag -> free.
 * 3. Else -> unknown (never fabricate free).
 */
export function deriveTier(input: TierInput): TierResult {
  const { inputPerMTok, outputPerMTok, free } = input;
  if (inputPerMTok !== null && outputPerMTok !== null) {
    const isFree = inputPerMTok === 0 && outputPerMTok === 0;
    return isFree ? { tier: 'free', free: true } : { tier: 'paid', free: false };
  }
  if (free === true) {
    return { tier: 'free', free: true };
  }
  return { tier: 'unknown', free: false };
}

export interface EntryToRowOptions {
  /**
   * CONN-0244's `ProviderAccess.use` (== `ConnectorsService.canUse(connector)`)
   * for this entry's connector. Defaults to true (fail-open) so callers that
   * don't yet model access — e.g. tests predating CONN-0245-EXT — keep prior
   * behavior unchanged. NOT ANDed with `executableHere` here — that stays a
   * separate, independent persisted column (see below); CONN-0244's own
   * `routable` local variable is pure `access.use`, and `buildDerivedTags`'s
   * `access:read-only` tag must reflect exactly that, not a compound.
   */
  useEnabled?: boolean;
}

/**
 * CONN-0245 / CONN-0245-EXT — write-path mapper: a `CatalogModelEntry` (as
 * produced by `ConnectorsService.buildCatalogSnapshot()`, which already
 * bakes CONN-0244's READ/USE gate into `available`) to a DB row for
 * `CatalogRepository.upsertSnapshot()`. `lastChecked` is stamped at map time
 * (cron-run time). `routable` persists CONN-0244's `access.use` value
 * verbatim (via the `useEnabled` option) so the read path
 * (`rowToEntry`) can reconstruct the `access:read-only` tag; `available`
 * itself is derived from `status`, which already encodes the FULL
 * CONN-0244 formula (`routable && executableHere && reachable &&
 * !modelBreakerOpen`) via `entry.available`.
 */
export function entryToRow(
  entry: CatalogModelEntry,
  { useEnabled = true }: EntryToRowOptions = {},
): ModelCatalogUpsert {
  const inputPerMTok = entry.pricing?.inputPerMTok ?? null;
  const outputPerMTok = entry.pricing?.outputPerMTok ?? null;
  const { tier, free } = deriveTier({ inputPerMTok, outputPerMTok, free: entry.free });

  return {
    connector: entry.connector,
    model: entry.model,
    modality: entry.modality,
    status: entry.available ? 'online' : 'offline',
    lastChecked: new Date(),
    supportsStreaming: entry.capabilities.supportsStreaming,
    supportsJsonSchema: entry.capabilities.supportsJsonSchema,
    supportsTools: entry.capabilities.supportsTools,
    inputPerMTok,
    outputPerMTok,
    priceUnit: entry.pricing?.unit ?? DEFAULT_PRICE_UNIT,
    tier,
    free,
    // QA FIX B (Finding 1) — persist the MC-side price multiplier verbatim
    // (NOT consulted by deriveTier above — tier/free stay real-tariff-only).
    priceMultiplier: entry.priceMultiplier ?? null,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    endpoint: entry.routing.endpoint ?? null,
    executableHere: isModalityExecutableHere(entry.modality),
    // CONN-0244 — pure `access.use`, independent of executableHere.
    routable: useEnabled,
  };
}

/**
 * CONN-0245 — read-path mapper: a persisted DB row back to a
 * `CatalogModelEntry` for `ConnectorsService.getCatalog()`. Preserves the
 * public `CatalogModelEntry` field names/types exactly (V-AC-1 contract).
 *
 * QA FIX B (Finding 1) — `priceMultiplier` IS a persisted column (added to
 * close an observable contract drift: the external site consumes both
 * `priceMultiplier` and `cheap`, and a prior version of this mapper
 * fabricated `priceMultiplier` from `tier` and collapsed `cheap` to
 * `≡ free` on the DB read path, silently changing both fields' values vs.
 * the live-assembly behavior). `cheap` is recomputed with the EXACT
 * pre-CONN-0245 formula (`free || (priceMultiplier !== null &&
 * priceMultiplier <= 1)`) — byte-identical to `ConnectorsService`'s original
 * assembly-time computation. `priceMultiplier` itself is never consulted by
 * `deriveTier`/`entryToRow` for tier/free (that stays real-tariff-only —
 * see `deriveTier`'s CONN-0244 false-free regression guard); it round-trips
 * purely as a passthrough value.
 *
 * CONN-0245-EXT — `row.routable` (CONN-0244's `access.use`, persisted
 * verbatim by `entryToRow`) is fed into `buildDerivedTags` so a READ-only
 * (USE=off) row still gets the `access:read-only` tag on read-back, exactly
 * as CONN-0244's live assembly did. `routable` is NOT re-exposed as its own
 * field on `CatalogModelEntry` (CONN-0244 never added one — only the
 * `available` boolean and the tag are externally visible) — `available`
 * comes straight from `status`, which already encodes the FULL CONN-0244
 * formula at persist time (see `entryToRow`).
 */
export function rowToEntry(row: ModelCatalogRow): CatalogModelEntry {
  const capabilities = {
    supportsStreaming: row.supportsStreaming,
    supportsJsonSchema: row.supportsJsonSchema,
    supportsTools: row.supportsTools,
  };
  const modality = row.modality as ModelModality;
  const pricing: ModelPricing | null =
    row.inputPerMTok === null && row.outputPerMTok === null
      ? null
      : { inputPerMTok: row.inputPerMTok, outputPerMTok: row.outputPerMTok, unit: row.priceUnit };
  const priceMultiplier = row.priceMultiplier;
  const cheap = row.free || (priceMultiplier !== null && priceMultiplier <= 1);

  return {
    connector: row.connector,
    model: row.model,
    modality,
    tags: buildDerivedTags({
      modality,
      free: row.free,
      cheap,
      capabilities,
      routable: row.routable,
    }),
    free: row.free,
    cheap,
    priceMultiplier,
    rateLimits: null,
    pricing,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    capabilities,
    routing: {
      connector: row.connector,
      model: row.model,
      ...(row.endpoint ? { endpoint: row.endpoint } : {}),
    },
    available: row.status === 'online',
  };
}
