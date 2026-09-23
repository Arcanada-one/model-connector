import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

interface DeepSeekChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * A2-209 — the ids DeepSeek actually serves, measured against the live API with the
 * operator key on 2026-09-23: `GET https://api.deepseek.com/models` returns exactly
 * `deepseek-flash` (DeepSeek-V4.1-Flash) and `deepseek-v4-pro` (DeepSeek-V4-Pro), and an
 * unknown id is refused with `"The supported API model names are deepseek-flash,
 * deepseek-v4-pro, but you passed ..."`. These are the same two ids the price map below
 * is keyed on, so the advertised catalogue and the priced catalogue are now one list.
 *
 * This replaces `['deepseek-chat', 'deepseek-reasoner']`, which DeepSeek's changelog
 * discontinued on 2026-07-24 (found by A2-201) and which `/models` has not listed since.
 * Advertising them cost us `deepseek-v4-pro`: the offline/CI floor listed two ids the
 * provider does not serve and omitted the one priced model a caller could actually reach
 * without a live refresh.
 */
const STATIC_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

/**
 * A2-209 — was `deepseek-chat`, a retired id. Kept deliberately as the FLASH model
 * rather than `deepseek-v4-pro`: flash is the cheaper of the two (see the price map),
 * which is the direction a default should err.
 *
 * BEHAVIOUR CHANGE, stated rather than buried — measured on the live API 2026-09-23 with
 * the identical prompt `"What is 17*23? Answer with the number only."` and
 * `max_tokens: 200`:
 *
 *   requested            served            reasoning_tokens   reasoning_content
 *   deepseek-chat        deepseek-flash    (absent)           no
 *   deepseek-flash       deepseek-flash    19                 yes
 *
 * So the old default was reasoning-OFF and the new one is reasoning-ON. A caller that
 * names no model will now spend reasoning tokens (billed at the OUTPUT rate) it did not
 * spend before. That is a real cost delta and the reason this line is not a silent
 * rename. It is taken anyway because the alternative is keeping a default pinned to an
 * id the provider already discontinued once and now honours only as an undocumented
 * alias — a default that fails closed the day that alias is withdrawn.
 *
 * Note for anyone restoring non-reasoning behaviour: `deepseek-flash` cannot be made
 * non-reasoning through `effort` — the live listing advertises `supported_levels:
 * ['low','high','max']` with no "off". The `deepseek-chat` alias is, as measured above,
 * the only route to non-reasoning flash, which is why {@link RETIRED_MODEL_ALIASES}
 * documents it instead of this connector rewriting it away.
 */
const DEFAULT_MODEL = 'deepseek-flash';

/**
 * A2-209 — retired / undocumented ids that DeepSeek still accepts, and what each was
 * measured to do. DOCUMENTATION ONLY: nothing in this connector routes on this table.
 *
 * Requests naming these ids are passed through to the provider VERBATIM. Rewriting them
 * locally to the served id was considered and rejected, because the aliases are not
 * equivalent to each other — measured 2026-09-23, same prompt and `max_tokens` as above:
 *
 *   requested            served            reasoning_tokens   reasoning_content
 *   deepseek-chat        deepseek-flash    (absent)           no
 *   deepseek-reasoner    deepseek-flash    17                 yes
 *   deepseek-v4-flash    deepseek-flash    18                 yes
 *
 * All three collapse onto one served id while carrying three different effort settings
 * that `response.model` cannot express. Mapping `deepseek-chat` → `deepseek-flash`
 * ourselves would silently turn a caller's non-reasoning request into a reasoning one and
 * bill them for it; the provider's own alias resolution preserves the distinction, so the
 * provider keeps that job. What this connector adds is visibility, not routing — see
 * `modelSubstituted` in {@link parseResponse}.
 *
 * `deepseek-v4-flash` is listed because it is what the fleet actually sends: every
 * automatic `coworker` profile pins it (`~/.claude`-adjacent `~/.config/coworker/
 * profiles.yaml`, and `documentation/infrastructure/Coworker.md` in the workspace). It is
 * not in `/models` either, so it is on exactly the same footing as the other two.
 */
export const RETIRED_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
};

/**
 * A2-201 — hand-curated list price per model, USD per 1M tokens, from
 * https://api-docs.deepseek.com/quick_start/pricing (fetched 2026-09-23; cross-checked
 * against three independent third-party trackers the same day, e.g.
 * https://benchlm.ai/deepseek/api-pricing "DeepSeek API Pricing (September 2026):
 * $0.30-$1.20 per 1M Tokens"). DeepSeek prices vary by time of day — off-peak
 * (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri) is HALF the peak rate. This catalogue has
 * one number per model, not a schedule, so PEAK is used deliberately: the same
 * conservative direction `measured-cost.ts` already takes for an unknown cache rate
 * ("can overstate the cost of a cache hit, and never understate it") — the caller-facing
 * risk this exists to close is a spend cap that never trips, not one that trips a few
 * cents early. `cachedInputPerMTok` (the cache-HIT price, ~1/50 of cache-miss) has no
 * catalogue column yet (see `MeasuredCostPricing.cachedInputPerMTok` in
 * `src/billing/measured-cost.ts`) — same gap Anthropic's list price already documents —
 * so it is left out here rather than invented; cached tokens bill at the miss rate below,
 * which is again the overstating direction. Recorded as `cache_rates: not_measured` in
 * the admission receipt.
 *
 * Keyed by the id DeepSeek's own API echoes back on `response.model` — `deepseek-flash`
 * and `deepseek-v4-pro` — which is what `meterCost()` (connectors.service.ts) looks up,
 * regardless of which alias the caller requested.
 *
 * A2-209 — the conflict A2-201 recorded here and could not resolve (this map priced
 * `deepseek-flash`/`deepseek-v4-pro` while `STATIC_MODELS` advertised `deepseek-chat`/
 * `deepseek-reasoner`) is now RESOLVED in this map's favour, by the live, authenticated
 * `GET /models` call A2-201 said was still owed: the provider serves exactly these two
 * ids, and `STATIC_MODELS` above has been corrected to match. The retired ids remain
 * unpriced here on purpose — they are aliases, and metering keys on the SERVED id the
 * provider echoes back, which is always one of the two below. See
 * {@link RETIRED_MODEL_ALIASES}.
 */
export const DEEPSEEK_LIST_PRICES_USD_PER_MTOK: Readonly<
  Record<string, { inputPerMTok: number; outputPerMTok: number }>
> = {
  'deepseek-flash': { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  'deepseek-v4-pro': { inputPerMTok: 1.32, outputPerMTok: 3.96 },
};
const PRICE_UNIT = 'USD/1M tokens';

/**
 * A2-209 — report a model substitution when, and only when, the provider itself
 * reported one.
 *
 * DeepSeek answers a request for a retired id with HTTP 200 and
 * `"model": "deepseek-flash"`. Nothing failed, so nothing surfaced: the response's
 * `model` field carried the served id and the requested one was discarded, leaving a
 * caller that pinned `deepseek-reasoner` for reproducibility unable to tell it had been
 * moved. Both ids are kept here so the fact is legible without a lookup table.
 *
 * Deliberately silent in three cases, each of which would otherwise produce a claim
 * nobody measured: the caller named no model (there is nothing to substitute FOR — the
 * connector's own DEFAULT_MODEL is not a caller's request), the provider echoed no model
 * at all, or the ids match. Comparison is case-insensitive because a case-only difference
 * is not a substitution any caller needs to act on.
 */
function modelSubstitution(
  requested: string | undefined,
  served: string | undefined,
): { modelSubstituted?: { requested: string; served: string } } {
  if (!requested || !served) return {};
  if (requested.toLowerCase() === served.toLowerCase()) return {};
  return { modelSubstituted: { requested, served } };
}

/** Attach the curated list price to a model meta; unknown ids keep `pricing: null`. */
function withListPrice(meta: ProviderModelMeta): ProviderModelMeta {
  const price = DEEPSEEK_LIST_PRICES_USD_PER_MTOK[meta.id];
  if (!price) return { ...meta, pricing: meta.pricing ?? null };
  return { ...meta, pricing: { ...price, unit: PRICE_UNIT } };
}

/**
 * Native adapter for the official DeepSeek OpenAI-compatible API.
 *
 * The provider supports more features than this bounded adapter advertises:
 * streaming, tools, and JSON schema remain false until implemented and tested.
 * @see https://api-docs.deepseek.com/
 */
export class DeepSeekConnector extends BaseApiConnector {
  readonly name = 'deepseek';

  protected getBaseUrl(): string {
    return process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  }

  private endpoint(path: string): string {
    const base = this.getBaseUrl();
    return `${base}${base.endsWith('/') ? '' : '/'}${path}`;
  }

  protected getStaticModels(): string[] {
    return STATIC_MODELS;
  }

  /** A2-201 — the offline/CI floor carries the curated list price, same as anthropic. */
  protected getStaticModelMetas(): ProviderModelMeta[] {
    return STATIC_MODELS.map((id) => withListPrice({ id }));
  }

  /**
   * A2-201 — DeepSeek's live `/models` listing carries no prices (ids only, see
   * `__fixtures__/models.json`), so without this override a successful refresh would
   * REPLACE the curated floor with an unpriced list and `measureCostUsd` would fall to
   * `'unpriced'` for every DeepSeek request — the exact bug this change closes. Merge:
   * live ids keep the curated price when one exists; unknown live ids stay unpriced
   * (null), never invented.
   */
  protected extractModels(json: unknown): ProviderModelMeta[] {
    return super.extractModels(json).map(withListPrice);
  }

  protected getModelsUrl(): string {
    return this.endpoint('models');
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ''}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return this.endpoint('chat/completions');
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') {
      throw new Error('deepseek connector requires string prompt');
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      messages,
      stream: false,
    };
    const extra = request.extra ?? {};
    if (extra.max_tokens != null) body.max_tokens = extra.max_tokens;
    // A2-209 — these four were suppressed whenever the model was `deepseek-reasoner`,
    // a rule written when that id named a separate reasoning model that rejected them.
    // The id is retired and the rule was measured stale: on 2026-09-23 a live request
    // with `model: 'deepseek-reasoner'` plus temperature/top_p/presence_penalty/
    // frequency_penalty returned HTTP 200 (served by deepseek-flash, reasoning intact),
    // as did the same parameters on `deepseek-flash` and `deepseek-v4-pro` directly.
    // Keeping the branch meant a caller's sampling parameters were dropped on the floor
    // for one string, silently — and the branch was about to go dead anyway once
    // DEFAULT_MODEL stopped being a retired id.
    //
    // not_measured: whether DeepSeek HONOURS these on an aliased request or merely
    // accepts them. Forwarding is still the better failure: the provider gets what the
    // caller asked for and can say no, instead of this connector deciding for it.
    for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) {
      if (extra[key] != null) body[key] = extra[key];
    }
    return body;
  }

  protected parseResponse(json: DeepSeekChatResponse, request: ConnectorRequest): ParsedApiOutput {
    const message = json.choices?.[0]?.message;
    if (!message) {
      return {
        text: '',
        model: json.model || request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No choices in DeepSeek response',
      };
    }
    const usage = json.usage;
    // AUP-CACHE-003 / A2-104 — DeepSeek reports prompt-cache use as
    // `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, which together are the
    // request's prompt tokens (https://api-docs.deepseek.com/guides/kv_cache). The hit
    // count is this codebase's `cachedInputTokens`: input tokens the provider served
    // from its cache, a SUBSET of inputTokens. Leaving it undefined while the counts sat
    // in `structured` made every consumer of the normalised usage read "the provider is
    // silent about caching" for a provider that had just reported a hit.
    //
    // There is deliberately NO `cacheCreationInputTokens` here: DeepSeek has no separate
    // cache-WRITE counter — a miss token is billed at the miss rate and is itself the
    // write — and a 0 would be indistinguishable from a measured zero on a provider that
    // does report writes.
    const cachedInputTokens =
      typeof usage?.prompt_cache_hit_tokens === 'number'
        ? usage.prompt_cache_hit_tokens
        : undefined;
    const cacheCounts =
      usage != null &&
      (typeof usage.prompt_cache_hit_tokens === 'number' ||
        typeof usage.prompt_cache_miss_tokens === 'number')
        ? {
            usage: {
              prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
              prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
            },
          }
        : {};
    return {
      text: message.content || '',
      structured: {
        ...(message.reasoning_content != null
          ? { reasoning_content: message.reasoning_content }
          : {}),
        // The counts are echoed only when DeepSeek actually sent them. The previous
        // `?? 0` filled a field the provider had left empty, which is the one thing
        // AUP-CACHE-003 says a connector must never do.
        ...cacheCounts,
      },
      model: json.model || request.model || DEFAULT_MODEL,
      ...modelSubstitution(request.model, json.model),
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      costUsd: 0,
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      // The provider's usage object verbatim: the typed fields above are a derived view,
      // this is the record.
      ...(usage != null ? { providerUsage: { ...usage } } : {}),
      // The third verdict: DeepSeek returned no usage at all, so the zeros above are
      // absences and must be readable as such rather than as measured zeros.
      ...(usage == null ? { usageMissing: true as const } : {}),
      isError: false,
    };
  }

  protected classifyHttpError(status: number, body: string): string {
    return status === 402 ? 'billing_error' : super.classifyHttpError(status, body);
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    return {
      name: 'deepseek',
      type: 'api',
      models: modelMeta.map((model) => model.id),
      modelMeta,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }
}
