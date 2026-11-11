/**
 * CONN-JEV-02 — typed transport routes for `typesafe-jev`.
 *
 * One `JevRoute` surface for direct (live shape) and OpenRouter/Cloudflare
 * stubs. The connector must not branch on "is this stub vs live"; configuration
 * + key presence decide availability. Stub routes stay `available:false` until
 * their env key is present — they must never invent a live success.
 *
 * Measured request/response envelopes: JEV-DECISION-LAYER-SPEC.md §2.2 / §2.4
 * (2026-09-22). Unmeasured Cloudflare fields stay explicit `not_observable` /
 * `null` branches (TZ §11.6).
 */

export type JevRouteId = 'direct' | 'openrouter' | 'cloudflare';

export type JevModelObserved = string | 'not_observable';

export interface JevRouteEnv {
  /** Direct API key. Accepts legacy `TYPESAFE_API_KEY` or `TYPESAFE_JEV_API_KEY`. */
  TYPESAFE_API_KEY?: string;
  TYPESAFE_JEV_API_KEY?: string;
  TYPESAFE_JEV_OPENROUTER_API_KEY?: string;
  TYPESAFE_JEV_CLOUDFLARE_API_TOKEN?: string;
  TYPESAFE_JEV_CLOUDFLARE_ACCOUNT_ID?: string;
  TYPESAFE_JEV_DIRECT_BASE_URL?: string;
  TYPESAFE_JEV_OPENROUTER_BASE_URL?: string;
  TYPESAFE_JEV_CLOUDFLARE_BASE_URL?: string;
  /**
   * Comma-separated enabled route ids. Default `direct`.
   * Stub routes remain `available:false` until both listed here AND keyed.
   */
  TYPESAFE_JEV_ROUTES_ENABLED?: string;
  /** Package version string for User-Agent (optional). */
  CONNECTOR_VERSION?: string;
}

export interface JevRouteParseResult {
  answers: Record<string, unknown>;
  model_observed: JevModelObserved;
  usage?: Record<string, number>;
  usage_missing?: true;
  request_id: string | null;
}

export interface JevRouteHttpError {
  type: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number | null;
  /** Present when the route key/account is missing — no network call. */
  code?: 'route_not_configured';
}

export type JevRouteConfigResult = { ok: true } | { ok: false; error: 'route_not_configured' };

export interface JevRoute {
  readonly id: JevRouteId;
  /**
   * Catalog honesty signal for this transport. Stub/unavailable routes MUST
   * report `false` — never invent live success (negative control CONN-JEV-02).
   */
  readonly available: boolean;
  buildUrl(env: JevRouteEnv): string;
  buildBody(state: unknown, questions: unknown, modelId: string): unknown;
  headers(env: JevRouteEnv): Record<string, string> | JevRouteConfigResult;
  parse(json: unknown, headers?: Headers): JevRouteParseResult;
  parseHttpError(status: number, text: string, headers?: Headers): JevRouteHttpError;
  modelIds(): readonly string[];
  pricingSource(): 'null' | 'openrouter-models' | 'direct-models-unconfirmed';
  versionObservability(): 'observed' | 'not_observable' | 'dated_slug';
  assertConfigured(env: JevRouteEnv): JevRouteConfigResult;
}

function trim(value: string | undefined): string {
  return (value ?? '').trim();
}

function enabledRoutes(env: JevRouteEnv): Set<JevRouteId> {
  const raw = trim(env.TYPESAFE_JEV_ROUTES_ENABLED);
  const parts = (raw || 'direct')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = new Set<JevRouteId>();
  for (const p of parts) {
    if (p === 'direct' || p === 'openrouter' || p === 'cloudflare') out.add(p);
  }
  if (out.size === 0) out.add('direct');
  return out;
}

function userAgent(env: JevRouteEnv): string {
  const ver = trim(env.CONNECTOR_VERSION) || '0.2.0';
  return `arcanada-model-connector/${ver}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usageFrom(body: Record<string, unknown>): {
  usage?: Record<string, number>;
  usage_missing?: true;
} {
  const raw = asRecord(body.usage);
  if (!raw) return { usage_missing: true };
  const usage: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) usage[k] = v;
  }
  if (Object.keys(usage).length === 0) return { usage_missing: true };
  return { usage };
}

function requestIdFrom(headers?: Headers): string | null {
  if (!headers) return null;
  const v =
    headers.get('x-typesafe-request-id') ?? headers.get('x-request-id') ?? headers.get('cf-ray');
  return v && v.trim() ? v.trim() : null;
}

function retryAfterMs(headers?: Headers): number | null {
  if (!headers) return null;
  const raw = headers.get('retry-after');
  if (!raw) return null; // unmeasured presence — explicit null, not invented
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

abstract class BaseJevRoute implements JevRoute {
  abstract readonly id: JevRouteId;
  abstract modelIds(): readonly string[];
  abstract pricingSource(): 'null' | 'openrouter-models' | 'direct-models-unconfirmed';
  abstract versionObservability(): 'observed' | 'not_observable' | 'dated_slug';
  abstract buildUrl(env: JevRouteEnv): string;
  abstract buildBody(state: unknown, questions: unknown, modelId: string): unknown;
  protected abstract readKey(env: JevRouteEnv): string;
  protected abstract authHeaders(env: JevRouteEnv, key: string): Record<string, string>;

  get available(): boolean {
    // Stubs and unkeyed routes stay false; never invent live success.
    const env = process.env as JevRouteEnv;
    return enabledRoutes(env).has(this.id) && Boolean(this.readKey(env));
  }

  assertConfigured(env: JevRouteEnv): JevRouteConfigResult {
    if (!enabledRoutes(env).has(this.id)) return { ok: false, error: 'route_not_configured' };
    if (!this.readKey(env)) return { ok: false, error: 'route_not_configured' };
    return { ok: true };
  }

  headers(env: JevRouteEnv): Record<string, string> | JevRouteConfigResult {
    const cfg = this.assertConfigured(env);
    if (!cfg.ok) return cfg;
    return {
      'Content-Type': 'application/json',
      'User-Agent': userAgent(env),
      ...this.authHeaders(env, this.readKey(env)),
    };
  }

  parse(json: unknown, headers?: Headers): JevRouteParseResult {
    const body = asRecord(json);
    if (!body) {
      return {
        answers: {},
        model_observed: 'not_observable',
        usage_missing: true,
        request_id: requestIdFrom(headers),
      };
    }
    const answers = asRecord(body.answers) ?? {};
    const modelRaw = body.model;
    const model_observed: JevModelObserved =
      typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : 'not_observable';
    return {
      answers,
      model_observed,
      request_id: requestIdFrom(headers),
      ...usageFrom(body),
    };
  }

  parseHttpError(status: number, text: string, headers?: Headers): JevRouteHttpError {
    const retryAfter = status === 429 ? retryAfterMs(headers) : null;
    let type = 'http_error';
    let retryable = false;
    if (status === 401 || status === 403) {
      type = 'auth_error';
      retryable = false;
    } else if (status === 422 || status === 400) {
      type = 'validation_error';
      retryable = false;
    } else if (status === 429) {
      type = 'rate_limited';
      retryable = true;
    } else if (status === 529 || status >= 500) {
      type = 'server_error';
      retryable = true;
    }
    return {
      type,
      message: `JEV HTTP ${status}`,
      retryable,
      retryAfterMs: retryAfter,
    };
  }
}

/** Live-shaped direct route: `POST {base}/v1/systemone`, body `{state,model,questions}`. */
export class DirectRoute extends BaseJevRoute {
  readonly id = 'direct' as const;
  modelIds(): readonly string[] {
    return ['jev-latest', 'jev-1.13.0', 'jev-preview'];
  }
  pricingSource() {
    return 'direct-models-unconfirmed' as const;
  }
  versionObservability() {
    return 'observed' as const;
  }
  protected readKey(env: JevRouteEnv): string {
    return trim(env.TYPESAFE_JEV_API_KEY) || trim(env.TYPESAFE_API_KEY);
  }
  protected authHeaders(_env: JevRouteEnv, key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}` };
  }
  buildUrl(env: JevRouteEnv): string {
    const base = trim(env.TYPESAFE_JEV_DIRECT_BASE_URL) || 'https://api.typesafe.ai';
    return `${base.replace(/\/$/, '')}/v1/systemone`;
  }
  buildBody(state: unknown, questions: unknown, modelId: string): unknown {
    return { state, model: modelId, questions };
  }
  parseHttpError(status: number, text: string, headers?: Headers): JevRouteHttpError {
    const base = super.parseHttpError(status, text, headers);
    // Measured direct error envelope: `{"detail":{error_type,message}}` (§2.4).
    try {
      const parsed = JSON.parse(text) as { detail?: { message?: string; error_type?: string } };
      const msg = parsed.detail?.message;
      if (typeof msg === 'string' && msg.trim()) {
        return { ...base, message: msg.trim() };
      }
    } catch {
      /* keep generic */
    }
    return base;
  }
}

/**
 * OpenRouter stub — measured request shape only (§2.4). Response success body
 * for this route was NOT live-measured without a key; fixtures use the dated
 * slug shape documented in the brief. Empty key → `route_not_configured`.
 */
export class OpenRouterRoute extends BaseJevRoute {
  readonly id = 'openrouter' as const;
  modelIds(): readonly string[] {
    return ['typesafe/jev-1.13', '~typesafe/jev-latest'];
  }
  pricingSource() {
    return 'openrouter-models' as const;
  }
  versionObservability() {
    return 'dated_slug' as const;
  }
  protected readKey(env: JevRouteEnv): string {
    return trim(env.TYPESAFE_JEV_OPENROUTER_API_KEY);
  }
  protected authHeaders(_env: JevRouteEnv, key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}` };
  }
  buildUrl(env: JevRouteEnv): string {
    const base = trim(env.TYPESAFE_JEV_OPENROUTER_BASE_URL) || 'https://openrouter.ai/api';
    return `${base.replace(/\/$/, '')}/v1/systemone`;
  }
  buildBody(state: unknown, questions: unknown, modelId: string): unknown {
    // OpenRouter requires noul.criteria {true,false} on the wire — callers must
    // supply measured questions; this route does not invent criteria.
    return { state, model: modelId, questions };
  }
  parseHttpError(status: number, text: string, headers?: Headers): JevRouteHttpError {
    const base = super.parseHttpError(status, text, headers);
    // Measured OpenRouter error envelope: `{"error":{…}}` even on compatible path.
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string | number } };
      const msg = parsed.error?.message;
      if (typeof msg === 'string' && msg.trim()) {
        return { ...base, message: msg.trim() };
      }
    } catch {
      /* keep generic */
    }
    return base;
  }
}

/**
 * Cloudflare Workers AI stub. Addressing form is unmeasured for `typesafe/jev`:
 * path-embedded model vs top-level `model` next to `input`. Both forms are
 * carried behind `addressing`; default is top-level model (brief measurement of
 * `/ai/run`). Version in the response envelope is `not_observable` by default.
 */
export class CloudflareRoute extends BaseJevRoute {
  readonly id = 'cloudflare' as const;
  /**
   * Unmeasured addressing fork (§2.4 / §11.6). Default `top_level_model`.
   * Live probe in CONN-JEV-09 may flip this without touching the interface.
   */
  addressing: 'top_level_model' | 'path_embedded' = 'top_level_model';

  modelIds(): readonly string[] {
    return ['typesafe/jev'];
  }
  pricingSource() {
    return 'null' as const;
  }
  versionObservability() {
    return 'not_observable' as const;
  }
  protected readKey(env: JevRouteEnv): string {
    const token = trim(env.TYPESAFE_JEV_CLOUDFLARE_API_TOKEN);
    const account = trim(env.TYPESAFE_JEV_CLOUDFLARE_ACCOUNT_ID);
    return token && account ? token : '';
  }
  protected authHeaders(env: JevRouteEnv, key: string): Record<string, string> {
    void env;
    return { Authorization: `Bearer ${key}` };
  }
  buildUrl(env: JevRouteEnv): string {
    const base =
      trim(env.TYPESAFE_JEV_CLOUDFLARE_BASE_URL) || 'https://api.cloudflare.com/client/v4';
    const account = trim(env.TYPESAFE_JEV_CLOUDFLARE_ACCOUNT_ID) || 'ACCOUNT_ID_UNSET';
    const root = base.replace(/\/$/, '');
    if (this.addressing === 'path_embedded') {
      return `${root}/accounts/${account}/ai/run/typesafe/jev`;
    }
    return `${root}/accounts/${account}/ai/run`;
  }
  buildBody(state: unknown, questions: unknown, modelId: string): unknown {
    // schema-input.json: required [state, questions]; model inside input forbidden.
    const input = { state, questions };
    if (this.addressing === 'path_embedded') {
      return { input };
    }
    return { model: modelId, input };
  }
  parse(json: unknown, headers?: Headers): JevRouteParseResult {
    const envelope = asRecord(json);
    if (!envelope) {
      return {
        answers: {},
        model_observed: 'not_observable',
        usage_missing: true,
        request_id: requestIdFrom(headers),
      };
    }
    // Cloudflare wraps provider payload in { result, success, errors }.
    if (envelope.success === false) {
      return {
        answers: {},
        model_observed: 'not_observable',
        usage_missing: true,
        request_id: requestIdFrom(headers),
      };
    }
    const result = asRecord(envelope.result) ?? envelope;
    // Version in Cloudflare envelope: unmeasured → default not_observable.
    const modelRaw = result.model ?? envelope.model;
    const model_observed: JevModelObserved =
      typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : 'not_observable';
    const answers = asRecord(result.answers) ?? {};
    return {
      answers,
      model_observed,
      request_id: requestIdFrom(headers),
      ...usageFrom(result),
    };
  }
  parseHttpError(status: number, text: string, headers?: Headers): JevRouteHttpError {
    const base = super.parseHttpError(status, text, headers);
    try {
      const parsed = JSON.parse(text) as {
        errors?: Array<{ message?: string; code?: number }>;
        success?: boolean;
      };
      const msg = parsed.errors?.[0]?.message;
      if (typeof msg === 'string' && msg.trim()) {
        return { ...base, message: msg.trim() };
      }
    } catch {
      /* keep generic */
    }
    return base;
  }
}

export const JEV_ROUTES: readonly JevRoute[] = [
  new DirectRoute(),
  new OpenRouterRoute(),
  new CloudflareRoute(),
];

export function getJevRoute(id: JevRouteId): JevRoute {
  const route = JEV_ROUTES.find((r) => r.id === id);
  if (!route) throw new Error(`unknown_jev_route:${id}`);
  return route;
}

/** Resolve route id from env enable-list (first enabled) or explicit pin. */
export function resolveJevRouteId(env: JevRouteEnv, pin?: JevRouteId): JevRouteId {
  if (pin) return pin;
  const enabled = enabledRoutes(env);
  if (enabled.has('direct')) return 'direct';
  if (enabled.has('openrouter')) return 'openrouter';
  if (enabled.has('cloudflare')) return 'cloudflare';
  return 'direct';
}

function routeKeyed(route: JevRouteId, env: JevRouteEnv): boolean {
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

/** Catalog rows for every known route model — stubs stay available:false. */
export function jevRouteCatalogEntries(
  env: JevRouteEnv = process.env as JevRouteEnv,
): Array<{ route: JevRouteId; model: string; available: boolean }> {
  const entries: Array<{ route: JevRouteId; model: string; available: boolean }> = [];
  for (const route of JEV_ROUTES) {
    const available = enabledRoutes(env).has(route.id) && routeKeyed(route.id, env);
    for (const model of route.modelIds()) {
      entries.push({ route: route.id, model, available });
    }
  }
  return entries;
}
