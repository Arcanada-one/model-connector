/**
 * A2-223 — every model MC can route to a paid provider must have a price, and
 * the build must go red the day one does not.
 *
 * ## What went wrong that this exists to stop
 *
 * `measureCostUsd` already refuses to invent a price: a model with no catalogue
 * tariff settles at `costUsd: 0` with `costSource: 'unpriced'`, loudly logged.
 * What nothing did was notice. Measured on arcana-devs 2026-09-23 against the
 * local Model Connector's own usage log:
 *
 *     cost_source | count |  tokens  | charged_usd
 *     ------------+-------+----------+------------
 *     provider    |   307 | 15554785 | 120.363277
 *     zero-usage  |   130 |        0 |   0.000000
 *     unpriced    |    41 |  1536472 |   0.000000
 *
 * The 41 unpriced rows are all `deepseek/deepseek-flash`, 1 491 471 input and
 * 45 001 output tokens, and at DeepSeek's published peak list price they are
 * $0.501443 that no key was debited for. Nothing alerted, nothing went red, and
 * two cards' worth of budget receipts built on `usage.costUsd` read $0.
 *
 * The same sweep of the production catalogue (`GET /connectors/catalog`,
 * 1068 rows) found 142 rows with neither a price nor a free flag.
 *
 * ## The rule
 *
 * Enumerated from the ROUTING TABLE — the connectors `ConnectorsModule`
 * actually registers, read from Nest's own DI metadata — never from a hand
 * list, because a hand list cannot go stale in the one direction that matters:
 * a NEW paid model added to a connector must fail this check, and it can only
 * do that if the check learns about it without anybody editing the check.
 *
 * Each routable model resolves to exactly one verdict:
 *
 *   priced       — a catalogue tariff exists. Nothing owed.
 *   free         — the provider's own free flag. A known price of zero.
 *   subscription — the lane is a seat, not a meter (see {@link BillingLane}).
 *   waived       — listed below, with a reason, an owner and an expiry.
 *   missing      — none of the above. The build is red.
 *
 * A waiver is not a silence. It carries who owns the gap and when the entry
 * stops working, and {@link auditPriceCoverage} fails on a waiver that has
 * EXPIRED, on one whose model has since been priced (stale), and on one naming
 * a model the routing table no longer has (dead) — so the list cannot quietly
 * outlive the thing it excuses.
 */

import type { BillingLane } from './measured-cost';

/** One routable (connector, model) pair as the routing table reports it. */
export interface RoutableModel {
  connector: string;
  model: string;
  /** Absent means `'api'` — see {@link BillingLane}. */
  lane?: BillingLane;
  /** The catalogue tariff the connector advertises, if any. */
  pricing?: { inputPerMTok?: number | null; outputPerMTok?: number | null } | null;
  /** The provider's own free-tier flag (e.g. groq, openrouter ':free'). */
  free?: boolean;
  /**
   * The model's modality when the connector declares one. A non-token modality
   * (image/video/speech) is NOT automatically excused — per-image and
   * per-second tariffs are real money too — but it is the reason several
   * waivers below exist, so it is recorded rather than dropped.
   */
  modality?: string | null;
}

export type PriceCoverageVerdict =
  | 'priced'
  | 'free'
  | 'subscription'
  | 'waived'
  | 'missing'
  /** The routing table could not be read for this entry. Never a pass. */
  | 'not_measured';

export interface PriceCoverageWaiver {
  connector: string;
  /** A model id, or `'*'` for every model of that connector. */
  model: string;
  reason: string;
  owner: string;
  /** ISO-8601 UTC. Past this instant the waiver stops working and CI goes red. */
  expiresAtUtc: string;
}

const WAIVER_OWNER = 'A2-223 executor (claude-opus-5, arcana-devs) / Model Connector owner';
/** 2026-11-04 re-measurement (CONV AC5 unblocker): see the per-entry reasons for what was and was not priced. */
/**
 * Six weeks. Long enough that a provider price hunt is a scheduled piece of
 * work rather than an emergency, short enough that nobody inherits this list as
 * permanent furniture.
 */
const WAIVER_EXPIRY = '2026-12-04T00:00:00Z';

/**
 * The gaps this change did NOT close, each one named.
 *
 * Every entry here was a silent `$0.000000` before it was written down. Listing
 * it does not price it — it makes the absence countable and gives it a date.
 */
export const PRICE_COVERAGE_WAIVERS: readonly PriceCoverageWaiver[] = [
  // ---- prices that exist but were not fetched on 2026-09-23 ----
  {
    connector: 'mistral',
    model: 'mistral-small-latest',
    reason:
      'Re-checked 2026-11-04: https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03 shows "$0.15 /M Tokens" and "$0.6 /M Tokens" without input/output labels, and no official page states which model the alias mistral-small-latest currently resolves to. Both the alias target and the direction of the two figures are unconfirmed, so no price is written. Next step: read GET /v1/models for the alias target and the labelled price from the Mistral pricing API/console.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'cerebras',
    model: '*',
    reason:
      'Re-checked 2026-11-04: https://www.cerebras.ai/pricing still renders its tier tables client-side (no figures in the fetched text) and https://inference-docs.cerebras.ai/models/overview carries no prices; zai-glm-4.7 is not in that catalogue page at all. gpt-oss-120b and zai-glm-4.7 stay unpriced rather than guessed. Next step: read the prices from the Cerebras console/API with an account.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'cohere',
    model: '*',
    reason:
      'Re-checked 2026-11-04: https://cohere.com/pricing does not list command-a-03-2025 (it lists Command R+ 08-2024 at $2.50 in / $10.00 out per 1M tokens, which is a different model) and docs.cohere.com/docs/command-a defers to the pricing page. No figure for this model on an official page, so none is written.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'huggingface',
    model: '*',
    reason:
      'Re-checked 2026-11-04 against https://huggingface.co/docs/inference-providers/index and /pricing: \':fastest\' is a provider-selection policy, not a product with its own price ("automatically selects the fastest available provider"); Hugging Face "charges you the same rates as the provider, with no additional fees", so the rate depends on which provider serves each request (per-provider prices are returned by GET /v1/models). No single number is correct; a per-request provider price would be needed.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'gemini-api',
    model: 'gemini-2.5-pro',
    reason:
      'Priced for gemini-2.5-flash on 2026-11-04 (see GEMINI_LIST_PRICES_USD_PER_MTOK). gemini-2.5-pro is tiered by prompt size (official page, retrieved 2026-11-04: $1.25 in / $10.00 out up to 200k tokens, $2.50 / $15.00 above) and the catalogue row holds one rate per direction, so a single number would mis-bill one side of the threshold. Needs a tiered tariff shape; the page also announces model re-routing from 2026-12-01.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },

  // ---- not per-token: the tariff exists, the SHAPE of the catalogue row does not ----
  {
    connector: 'grok',
    model: 'grok-imagine-image',
    reason:
      'Image model billed per image. Official price (https://docs.x.ai/developers/models, Imagine Pricing, retrieved 2026-11-04): $0.02 per image. Not written to the catalogue because MeasuredCostPricing has no per-image tariff shape (a per-MTok row would be a category error); the shape is the open work.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'grok',
    model: 'grok-imagine-image-quality',
    reason:
      'Image model billed per image. No row for grok-imagine-image-quality in the official table (https://docs.x.ai/developers/models, retrieved 2026-11-04); the neighbouring grok-imagine-image-2.0 ($0.04 per image) is a different model and is not used as a stand-in. Also needs a per-image tariff shape.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'grok',
    model: 'grok-imagine-video',
    reason:
      'Video model billed per second. Official price (https://docs.x.ai/developers/models, retrieved 2026-11-04): $0.050 per second. Not written: no per-second tariff shape on MeasuredCostPricing.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'grok',
    model: 'grok-imagine-video-1.5',
    reason:
      'Video model billed per second. Official price (https://docs.x.ai/developers/models, retrieved 2026-11-04): $0.080 per second. Not written: no per-second tariff shape on MeasuredCostPricing.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'bedrock-nova-media',
    model: '*',
    reason:
      'amazon.nova-canvas / nova-reel are billed per image and per second. Re-checked 2026-11-04: https://aws.amazon.com/bedrock/pricing/ and https://aws.amazon.com/nova/pricing/ did not yield the creative-content figures in the fetched text (client-rendered or outside the part read). No figure written; also needs the per-image/per-second tariff shape.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },

  // ---- the static floor is a bootstrap stub the live listing replaces ----
  {
    connector: 'openrouter',
    model: '*',
    reason:
      "OpenRouter's /models listing carries machine prices and the connector already reads them: the production catalogue showed 456/456 openrouter rows priced on 2026-09-23. The six static ids are a cold-boot stub, so the exposure is the window between boot and the first successful refresh — real, but bounded, and closing it means curating six prices that the provider hands us for free a few seconds later.",
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'orq',
    model: '*',
    reason:
      'Same as openrouter: 458/458 orq rows were priced in the production catalogue on 2026-09-23, from the provider listing. The three static ids are a cold-boot stub.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'openmodel',
    model: '*',
    reason:
      'OpenModel is a READ-only provider by default (PROVIDER_ACCESS "openmodel:read" — visible in the catalogue, not routable), so an unpriced row here cannot become an unbilled call while that default holds. The waiver, not an exemption in the rule, because the default is an env var and an operator can flip it.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'modal-endpoints',
    model: '*',
    reason:
      "Modal is a BYO-endpoint connector: the operator points it at their own deployment (MODAL_ENDPOINT_URL) and pays Modal for compute time, not per token. With no endpoint configured it advertises the literal id 'unconfigured' (modal.connector.ts, environmentConfig()), which is a placeholder rather than a model, and once configured the model id is whatever the operator's endpoint serves — unknowable from this repository. No per-MTok tariff can be correct here.",
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
  {
    connector: 'embedding',
    model: '*',
    reason:
      'bge-m3 is served by our own Scrutator deployment, not bought per token. It has no vendor price to fetch; what it has is an infrastructure cost, which is not what this catalogue measures.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
];

/**
 * Connectors the routing table lists but cannot be ENUMERATED offline.
 *
 * Distinct from a waiver on purpose: a waiver says "this model has no price and
 * here is why", this says "we could not even ask". That is `not_measured`, the
 * third verdict, and it must be declared rather than swallowed by a `try`.
 */
export const PRICE_COVERAGE_ENUMERATION_GAPS: readonly {
  connector: string;
  reason: string;
  owner: string;
  expiresAtUtc: string;
}[] = [
  {
    connector: 'VertexGenerativeConnector',
    reason:
      'Cannot be constructed without its injected config: `new VertexGenerativeConnector()` then `getCapabilities()` throws "Cannot read properties of undefined (reading \'models\')". Its models are therefore invisible to this audit — not proven priced, not proven unpriced.',
    owner: WAIVER_OWNER,
    expiresAtUtc: WAIVER_EXPIRY,
  },
];

function hasTariff(entry: RoutableModel): boolean {
  const p = entry.pricing;
  if (!p) return false;
  return (
    (typeof p.inputPerMTok === 'number' && Number.isFinite(p.inputPerMTok)) ||
    (typeof p.outputPerMTok === 'number' && Number.isFinite(p.outputPerMTok))
  );
}

/** The waiver covering this model, if one is live at `now`. Exact id beats `'*'`. */
export function findWaiver(
  entry: Pick<RoutableModel, 'connector' | 'model'>,
  waivers: readonly PriceCoverageWaiver[],
  now: Date,
): { waiver: PriceCoverageWaiver; expired: boolean } | null {
  const candidates = waivers.filter(
    (w) => w.connector === entry.connector && (w.model === entry.model || w.model === '*'),
  );
  if (candidates.length === 0) return null;
  const exact = candidates.find((w) => w.model === entry.model) ?? candidates[0];
  return { waiver: exact, expired: Date.parse(exact.expiresAtUtc) <= now.getTime() };
}

/**
 * The verdict for one routable model.
 *
 * Order is load-bearing. `priced` is checked FIRST so that a model which has
 * since acquired a price reports `priced` even while a waiver still names it —
 * that is what lets {@link auditPriceCoverage} spot the stale waiver instead of
 * the waiver hiding the fact that it is no longer needed. An EXPIRED waiver
 * yields `missing`, not `waived`: an expiry that does not bite is a comment.
 */
export function classifyPriceCoverage(
  entry: RoutableModel,
  waivers: readonly PriceCoverageWaiver[] = PRICE_COVERAGE_WAIVERS,
  now: Date = new Date(),
): PriceCoverageVerdict {
  if (hasTariff(entry)) return 'priced';
  if (entry.free === true) return 'free';
  if (entry.lane === 'subscription') return 'subscription';
  const hit = findWaiver(entry, waivers, now);
  if (hit && !hit.expired) return 'waived';
  return 'missing';
}

export interface PriceCoverageAudit {
  /** Routable, paid, unpriced and unexcused. Any entry here is a red build. */
  missing: RoutableModel[];
  /** Waived, but the waiver has passed its expiry. Red. */
  expired: { entry: RoutableModel; waiver: PriceCoverageWaiver }[];
  /** A waiver naming a model that HAS a price now. Red: delete the waiver. */
  stale: PriceCoverageWaiver[];
  /** A waiver naming a (connector, model) the routing table no longer has. Red. */
  dead: PriceCoverageWaiver[];
  /** Counts by verdict, for the receipt. */
  counts: Record<PriceCoverageVerdict, number>;
}

export function auditPriceCoverage(
  entries: readonly RoutableModel[],
  waivers: readonly PriceCoverageWaiver[] = PRICE_COVERAGE_WAIVERS,
  now: Date = new Date(),
): PriceCoverageAudit {
  const counts: Record<PriceCoverageVerdict, number> = {
    priced: 0,
    free: 0,
    subscription: 0,
    waived: 0,
    missing: 0,
    not_measured: 0,
  };
  const missing: RoutableModel[] = [];
  const expired: { entry: RoutableModel; waiver: PriceCoverageWaiver }[] = [];

  for (const entry of entries) {
    const verdict = classifyPriceCoverage(entry, waivers, now);
    counts[verdict] += 1;
    if (verdict !== 'missing') continue;
    const hit = findWaiver(entry, waivers, now);
    if (hit?.expired) expired.push({ entry, waiver: hit.waiver });
    else missing.push(entry);
  }

  // A waiver is stale when every model it covers is priced now, and dead when
  // it covers nothing the routing table still lists. Both are the same failure
  // — a list that stopped describing reality — and both are caught here rather
  // than left to a reader noticing.
  const stale: PriceCoverageWaiver[] = [];
  const dead: PriceCoverageWaiver[] = [];
  for (const waiver of waivers) {
    const covered = entries.filter(
      (e) => e.connector === waiver.connector && (waiver.model === '*' || e.model === waiver.model),
    );
    if (covered.length === 0) {
      dead.push(waiver);
      continue;
    }
    // A wildcard waiver is stale only when it excuses nothing at all any more.
    const stillNeeded = covered.some(
      (e) => classifyPriceCoverage(e, [], now) === 'missing' && findWaiver(e, [waiver], now),
    );
    if (!stillNeeded) stale.push(waiver);
  }

  return { missing, expired, stale, dead, counts };
}

/** A one-line-per-finding rendering, so a failing assertion says what to fix. */
export function formatPriceCoverageAudit(audit: PriceCoverageAudit): string {
  const lines: string[] = [];
  for (const m of audit.missing) {
    lines.push(
      `MISSING  ${m.connector}/${m.model} — routable on a paid lane with no tariff and no waiver. ` +
        `Every call settles costUsd 0.000000 / costSource 'unpriced'. Add a price to the connector's ` +
        `list-price map, or add a dated waiver to PRICE_COVERAGE_WAIVERS saying why there is none.`,
    );
  }
  for (const e of audit.expired) {
    lines.push(
      `EXPIRED  ${e.entry.connector}/${e.entry.model} — waiver expired ${e.waiver.expiresAtUtc}: ${e.waiver.reason}`,
    );
  }
  for (const w of audit.stale) {
    lines.push(
      `STALE    ${w.connector}/${w.model} — waived, but everything it covers is priced now. Delete the waiver.`,
    );
  }
  for (const w of audit.dead) {
    lines.push(
      `DEAD     ${w.connector}/${w.model} — waiver names nothing the routing table still lists. Delete the waiver.`,
    );
  }
  return lines.join('\n');
}
