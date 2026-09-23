import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import {
  CircuitBreakerResetEntry,
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  CatalogRefreshResult,
  IConnector,
  ProviderModelMeta,
  classifyErrorAction,
  retryAfterFields,
} from './interfaces/connector.interface';
import { Semaphore, QueueTimeoutError } from './base-cli.connector';
import { resolveAttemptBudget } from './attempt-budget';
import { getConfig } from '../config/env.schema';
import { isTimeoutAbort } from '../core/utils/abort';
import { CircuitOpenError } from '../core/resilience/circuit-breaker';
import { CircuitBreakerManager } from '../core/resilience/circuit-breaker-manager';

export interface ParsedApiOutput {
  text: string;
  structured?: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Cost as the PROVIDER reported it, or 0 when the provider reports none —
   * which is almost all of them (only claude-code and openrouter return a real
   * figure). 0 is not a claim that the call was free; it means "unreported", and
   * `ConnectorsService.meterCost()` (ARAS-0058) prices the tokens from the
   * catalogue instead. A connector must never compute a price of its own here:
   * that would be a second pricing source, drifting from the first.
   */
  costUsd: number;
  /**
   * Cache and reasoning counts, when the provider reports them (CONN-0272).
   * Both are SUBSETS of the corresponding total, matching how providers report
   * them. Undefined means the provider said nothing; 0 means it reported none.
   */
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  /**
   * AUP-CACHE-003 / DEC-AUP-0028 — prompt-cache write tokens and their TTL
   * breakdown, the provider `usage` object verbatim, and the third verdict
   * `usageMissing` (provider returned no usage at all). See
   * `ConnectorResponse.usage` for the semantics; forwarded untouched.
   */
  cacheCreationInputTokens?: number;
  cacheCreation?: { ephemeral5mInputTokens?: number; ephemeral1hInputTokens?: number };
  providerUsage?: Record<string, unknown>;
  usageMissing?: true;
  isError: boolean;
  errorMessage?: string;
}

/** CONN-0254 — provider-specific decomposition of a non-2xx HTTP response. */
export interface ParsedHttpError {
  type: string;
  message: string;
  /**
   * A2-207 — MILLISECONDS, like {@link ConnectorError.retryAfter}. A provider's
   * `Retry-After` header is in seconds (RFC 9110) and must be multiplied here,
   * as perplexity.connector.ts does. `execute` derives `retryAfterSeconds` from
   * this figure.
   */
  retryAfter?: number;
  details?: unknown;
}

export abstract class BaseApiConnector implements IConnector {
  readonly type = 'api' as const;
  abstract readonly name: string;

  protected activeJobs = 0;
  private _semaphore?: Semaphore;
  private _cbManager?: CircuitBreakerManager;

  // CONN-0236 — dynamic model completeness. Connectors whose provider exposes a
  // `/models` listing override getStaticModels()/getModelsUrl() and return
  // `this.dynamicModels` from getCapabilities(). refreshModels() populates the
  // cache on boot; the static list is the offline/CI fallback (no live call in CI).
  // Named distinctly from OpenRouterConnector's own `_dynamicModels` field — TS
  // forbids a subclass redeclaring a base private of the same name.
  // CONN-0238 — store per-model metadata (not just ids); REPLACE semantics.
  private _refreshedModels?: ProviderModelMeta[];
  private readonly _modelsLogger = new Logger('ConnectorModelRefresh');

  protected get semaphore(): Semaphore {
    if (!this._semaphore) {
      try {
        const config = getConfig();
        const envKey =
          `${this.name.toUpperCase().replace(/-/g, '_')}_MAX_CONCURRENCY` as keyof typeof config;
        const limit = (config[envKey] as number | undefined) ?? config.CONNECTOR_MAX_CONCURRENCY;
        this._semaphore = new Semaphore(limit);
      } catch {
        this._semaphore = new Semaphore(4);
      }
    }
    return this._semaphore;
  }

  /** @internal For testing only */
  setSemaphore(max: number): void {
    this._semaphore = new Semaphore(max);
  }

  protected getQueueTimeout(): number {
    try {
      return getConfig().CONNECTOR_QUEUE_TIMEOUT_MS;
    } catch {
      return 60_000;
    }
  }

  protected get cbManager(): CircuitBreakerManager {
    if (!this._cbManager) {
      try {
        const config = getConfig();
        this._cbManager = new CircuitBreakerManager(
          this.name,
          config.CIRCUIT_BREAKER_THRESHOLD,
          config.CIRCUIT_BREAKER_COOLDOWN_MS,
        );
      } catch {
        this._cbManager = new CircuitBreakerManager(this.name, 5, 30_000);
      }
    }
    return this._cbManager;
  }

  protected abstract getBaseUrl(): string;
  protected abstract buildRequestUrl(request: ConnectorRequest): string;
  protected abstract buildRequestBody(request: ConnectorRequest): unknown;
  protected abstract parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput;
  abstract getCapabilities(): ConnectorCapabilities;

  /**
   * A2-207 — the per-attempt budget handed to `AbortSignal.timeout` below.
   *
   * This used to return a hard-coded 30 000 while `CONNECTOR_TIMEOUT_MS` was
   * declared in env.schema.ts, documented in README, parity-checked by CI and
   * set to 300 000 on dev boxes — and read by nobody. An operator who "raised
   * the timeout" raised nothing, and a request that named no `timeout` of its
   * own died at 30 s no matter what, on a connector advertising
   * `maxTimeout: 300_000`.
   *
   * Precedence, and the one shape every override follows:
   *   request.timeout  >  {NAME}_TIMEOUT_MS  >  CONNECTOR_TIMEOUT_MS  >  120 000
   *
   * The `{NAME}_TIMEOUT_MS` key is DERIVED from the connector name, exactly as
   * the `{NAME}_MAX_CONCURRENCY` key already is above, rather than restated in
   * seventeen overrides that each repeated `|| 120_000`. That duplication was
   * the second half of the same defect: `OLLAMA_TIMEOUT_MS` is declared in
   * .env.example and `ollama.connector.ts` never wrote an override, so an
   * operator setting it got nothing either.
   *
   * The fallback is used only when the env cannot be validated at all (specs
   * that construct a connector without an environment); it matches the schema
   * default so the two cannot drift.
   */
  protected getTimeout(): number {
    const envKey = `${this.name.toUpperCase().replace(/-/g, '_')}_TIMEOUT_MS`;
    const perConnector = Number(process.env[envKey]);
    if (Number.isFinite(perConnector) && perConnector > 0) return perConnector;
    try {
      return getConfig().CONNECTOR_TIMEOUT_MS;
    } catch {
      return 120_000;
    }
  }

  /**
   * A2-210 — the ceiling this connector advertises, read defensively.
   * `getCapabilities()` is connector-authored and some implementations build it
   * from live catalog state; a throw here must cost the request its ceiling,
   * never the request itself.
   */
  protected advertisedMaxTimeout(): number | undefined {
    try {
      return this.getCapabilities().maxTimeout;
    } catch {
      return undefined;
    }
  }

  protected getHeaders(): Record<string, string> | Promise<Record<string, string>> {
    return { 'Content-Type': 'application/json' };
  }

  /**
   * CONN-0243 — per-request headers. Defaults to {@link getHeaders}; override when
   * the auth material depends on the request (e.g. Azure deployment-scoped keys).
   */
  protected async getRequestHeaders(_request: ConnectorRequest): Promise<Record<string, string>> {
    return this.getHeaders();
  }

  /** CONN-0243 — provider-specific rendering of a non-2xx response body. */
  protected formatHttpErrorMessage(_status: number, body: string): string {
    return body.slice(0, 500);
  }

  /**
   * CONN-0254 — provider-specific decomposition of a non-2xx response. The default
   * composes {@link classifyHttpError} with {@link formatHttpErrorMessage}.
   */
  protected parseHttpError(status: number, text: string, _headers: Headers): ParsedHttpError {
    return {
      type: this.classifyHttpError(status, text),
      message: this.formatHttpErrorMessage(status, text),
    };
  }

  // ARCA-0011 — connectors opt into multimodal `ContentBlock[]` prompts.
  // Default `false`; openrouter overrides to `true` in Phase 1.
  protected get supportsContentBlocks(): boolean {
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CONN-0236 — Dynamic model completeness
  //
  // Generalizes the proven OpenRouterConnector.refreshFreeModels() pattern
  // (CONN-0233): fetch the provider's `/models` listing, parse the ids, and cache
  // them so getCapabilities().models reflects the provider's REAL catalogue instead
  // of a hand-maintained stub. The static list (getStaticModels) is the source of
  // truth for in-memory connector operation offline and in CI. A failed dynamic
  // observation leaves that list intact but does not make it persistence-grade
  // static provenance; CatalogRefreshService defers the provider instead.
  //
  // NOTE: OpenRouterConnector keeps its own specialized refreshFreeModels()
  // (CONN-0233) instead of this generic refresh — it additionally derives the
  // free-model set from pricing / ":free" id suffixes. This base method is the
  // plain id-list path for providers without that pricing semantics
  // (openmodel / groq / grok). Do not fold openrouter in here without porting its
  // pricing-aware free detection.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The hand-curated / cited model list. Used verbatim until refreshModels()
   * succeeds, and as the permanent fallback when the provider is unreachable.
   * Override per connector. Default `[]` keeps non-participating connectors inert.
   */
  protected getStaticModels(): string[] {
    return [];
  }

  /**
   * Provider model-listing endpoint. Defaults to `{baseUrl}/models`; override when
   * the provider nests it elsewhere (groq → `/openai/v1/models`, grok → `/v1/models`).
   */
  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/models`;
  }

  /**
   * Static model metadata (offline/CI fallback). Defaults to the plain id list
   * stamped with no modality (the catalog applies the connector default). Override
   * when the static floor spans modalities (e.g. grok-imagine image/video).
   */
  protected getStaticModelMetas(): ProviderModelMeta[] {
    return this.getStaticModels().map((id) => ({ id }));
  }

  /**
   * CONN-0238 — parse the provider's `/models` JSON into per-model metadata.
   * Default handles the OpenAI/Anthropic-compatible `{ data: [{ id }] }` shape and
   * stamps no modality/pricing. Override to classify modality, filter, or surface
   * pricing/context from the provider list (groq, grok). Replaces the old
   * `extractModelIds` (id-only) seam.
   */
  protected extractModels(json: unknown): ProviderModelMeta[] {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => (entry as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({ id }));
  }

  /**
   * Per-model metadata getCapabilities() should expose: the refreshed provider
   * metas once available, otherwise the static fallback metas.
   */
  protected get dynamicModelMetas(): ProviderModelMeta[] {
    return this._refreshedModels ?? this.getStaticModelMetas();
  }

  /**
   * The flat id list getCapabilities().models should return — derived from
   * {@link dynamicModelMetas} so ids and per-model metadata never drift.
   */
  protected get dynamicModels(): string[] {
    return this.dynamicModelMetas.map((m) => m.id);
  }

  /** CONN-0247 — replace the provider-model cache after a connector-specific refresh. */
  protected replaceRefreshedModels(models: ProviderModelMeta[]): void {
    this._refreshedModels = models;
  }

  /**
   * Headers for the `/models` listing request. Defaults to the connector's normal
   * {@link getHeaders}. Override when the model-listing endpoint needs a different
   * auth scheme than the chat endpoint — e.g. OpenModel's chat uses `x-api-key`
   * (Anthropic-style) while its OpenAI-compatible `/v1/models` requires
   * `Authorization: Bearer` (CONN-0236).
   */
  protected getModelsHeaders(): Record<string, string> | Promise<Record<string, string>> {
    return this.getHeaders();
  }

  /** CONN-0242 — optional provider-specific continuation URL for paginated model listings. */
  protected getNextModelsUrl(_json: unknown): string | undefined {
    return undefined;
  }

  /**
   * Fetch the provider's `/models` listing and REPLACE the cached model list with
   * the live provider list (CONN-0238). The static list is the OFFLINE-ONLY
   * fallback — it is NOT merged into a successful live result, so stale/phantom
   * static ids cannot survive a refresh (the CONN-0236 UNION leaked them: grok
   * 18 = 9 real + 9 phantom). Fire-and-forget on boot; tolerates every failure
   * (non-2xx, empty, network/parse error) by leaving the static list in place.
   * Never throws — safe to `void` from OnModuleInit.
   */
  async refreshModels(): Promise<CatalogRefreshResult> {
    const staticCount = this.getStaticModels().length;
    const checkedAt = new Date();
    const metas: ProviderModelMeta[] = [];
    // CONN-0242 — providers with paginated /models listings continue via getNextModelsUrl().
    let pageUrl: string | undefined = this.getModelsUrl();
    while (pageUrl) {
      let response: Response;
      try {
        response = await fetch(pageUrl, {
          method: 'GET',
          headers: await this.getModelsHeaders(),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        this._modelsLogger.warn(
          `${this.name} model refresh failed: reason=network — keeping ${staticCount} static models`,
        );
        return { status: 'failed', source: 'provider-api', checkedAt, reason: 'network' };
      }
      if (!response.ok) {
        this._modelsLogger.warn(
          `${this.name} model refresh returned status=${response.status} — keeping ${staticCount} in-memory fallback models`,
        );
        return { status: 'failed', source: 'provider-api', checkedAt, reason: 'http' };
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        this._modelsLogger.warn(
          `${this.name} model refresh failed: reason=parse — keeping ${staticCount} static models`,
        );
        return { status: 'failed', source: 'provider-api', checkedAt, reason: 'parse' };
      }

      metas.push(...this.extractModels(json));
      pageUrl = this.getNextModelsUrl(json);
    }

    if (metas.length === 0) {
      this._modelsLogger.warn(
        `${this.name} /models response had no usable ids — keeping ${staticCount} static models`,
      );
      return { status: 'failed', source: 'provider-api', checkedAt, reason: 'empty' };
    }
    // REPLACE, not UNION — the live provider list is the sole source of truth.
    this.replaceRefreshedModels(metas);
    const observedAt = new Date();
    this._modelsLogger.log(
      `${this.name} model refresh: ${metas.length} provider models (replaced ${staticCount} static)`,
    );
    return { status: 'success', source: 'provider-api', observedAt };
  }

  async refreshCatalogModels(): Promise<CatalogRefreshResult> {
    return this.refreshModels();
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const id = randomUUID();

    if (Array.isArray(request.prompt) && !this.supportsContentBlocks) {
      const action = classifyErrorAction('unsupported_modality');
      return {
        id,
        connector: this.name,
        model: request.model || 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs: 0,
        queueWaitMs: 0,
        status: 'error',
        error: {
          type: 'unsupported_modality',
          message: `Connector '${this.name}' does not accept ContentBlock[] prompts`,
          ...action,
        },
      };
    }

    // Circuit breaker check (per-model)
    const modelCb = this.cbManager.getCircuitBreaker(request.model ?? '');
    try {
      modelCb.check();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        const action = classifyErrorAction('circuit_open');
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 0,
          queueWaitMs: 0,
          status: 'error',
          error: {
            type: 'circuit_open',
            message: err.message,
            ...retryAfterFields(err.nextRetryAt - Date.now()),
            ...action,
          },
        };
      }
      throw err;
    }

    const queueStart = Date.now();

    try {
      await this.semaphore.acquire(this.getQueueTimeout());
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        const action = classifyErrorAction('queue_timeout');
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: Date.now() - queueStart,
          queueWaitMs: Date.now() - queueStart,
          status: 'error',
          error: { type: 'queue_timeout', message: err.message, ...action },
        };
      }
      throw err;
    }

    const queueWaitMs = Date.now() - queueStart;
    // A2-207 — whose budget is about to run out. A caller that asked for LESS
    // time than this connector would have allowed is not evidence about the
    // provider: see the timeout branch of the catch below.
    // A2-210 — and `getCapabilities().maxTimeout` is the ceiling over both, at
    // last read by something. See resolveAttemptBudget.
    const { timeoutMs: timeout, callerBudgetIsShorter } = resolveAttemptBudget(
      request.timeout,
      this.getTimeout(),
      this.advertisedMaxTimeout(),
    );
    const start = Date.now();

    this.activeJobs++;
    try {
      const url = this.buildRequestUrl(request);
      const body = this.buildRequestBody(request);

      const res = await fetch(url, {
        method: 'POST',
        headers: await this.getRequestHeaders(request),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });

      if (!res.ok) {
        const text = await res.text();
        const parsedError = this.parseHttpError(res.status, text, res.headers);
        const errorType = parsedError.type;
        const action = classifyErrorAction(errorType);
        // A2-207 — connectors report a provider retry delay in ms (see
        // ParsedHttpError.retryAfter); the seconds twin is derived here so no
        // connector has to remember to emit it.
        const retryAfterOut =
          parsedError.retryAfter !== undefined ? retryAfterFields(parsedError.retryAfter) : {};
        modelCb.recordFailure(errorType);
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: Date.now() - start,
          queueWaitMs,
          status: errorType === 'rate_limited' ? 'rate_limited' : 'error',
          error: { ...parsedError, ...retryAfterOut, ...action },
        };
      }

      const json = await res.json();
      const parsed = this.parseResponse(json, request);

      const base: ConnectorResponse = {
        id,
        connector: this.name,
        model: parsed.model || request.model || 'unknown',
        result: parsed.text,
        structured: parsed.structured,
        usage: {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalTokens: parsed.inputTokens + parsed.outputTokens,
          costUsd: parsed.costUsd,
          // CONN-0272 — forwarded only when the provider reported them.
          // `undefined` (provider is silent) and `0` (provider reported a miss)
          // are different facts and are kept different all the way to the row.
          cachedInputTokens: parsed.cachedInputTokens,
          reasoningOutputTokens: parsed.reasoningOutputTokens,
          // AUP-CACHE-003 / DEC-AUP-0028 — cache writes, TTL breakdown, the
          // verbatim provider usage and the third verdict. Spread only when
          // present so connectors that do not report them leave no key behind.
          ...(parsed.cacheCreationInputTokens !== undefined
            ? { cacheCreationInputTokens: parsed.cacheCreationInputTokens }
            : {}),
          ...(parsed.cacheCreation !== undefined ? { cacheCreation: parsed.cacheCreation } : {}),
          ...(parsed.providerUsage !== undefined ? { providerUsage: parsed.providerUsage } : {}),
          ...(parsed.usageMissing ? { usageMissing: true as const } : {}),
        },
        latencyMs: Date.now() - start,
        queueWaitMs,
        status: parsed.isError ? 'error' : 'success',
      };

      if (parsed.isError) {
        const action = classifyErrorAction('api_error');
        base.error = {
          type: 'api_error',
          message: parsed.errorMessage || 'Unknown API error',
          ...action,
        };
        modelCb.recordFailure('api_error');
      } else {
        modelCb.recordSuccess();
      }

      return base;
    } catch (err) {
      const latencyMs = Date.now() - start;
      // A2-210 — `AbortSignal.timeout()` (the only thing that aborts the fetch
      // above) rejects with a DOMException named 'TimeoutError'. This asked for
      // 'AbortError', so the branch was unreachable and EVERY provider timeout
      // left here as `network_error` carrying the message "The operation was
      // aborted due to timeout" — a network-error envelope around a deadline we
      // set ourselves. It cost A2-205/A2-206 two investigation cards, and it
      // silently disabled #139's rule below, which keys on `'timeout'`.
      const isAbort = isTimeoutAbort(err);
      const message = err instanceof Error ? err.message : String(err);
      const errorType = isAbort
        ? 'timeout'
        : message.includes('SyntaxError') || message.includes('Unexpected')
          ? 'parse_error'
          : 'network_error';
      const action = classifyErrorAction(errorType);

      // A2-207 — the narrowest rule we can defend: a timeout is counted against
      // the shared per-model breaker UNLESS it was the CALLER's own, shorter
      // budget that expired. The breaker exists to take a sick route out of
      // service for everybody; "this client would not wait as long as we would
      // have" says nothing about the route's health, and the client is the only
      // one who learns anything from it (it already gets status: timeout).
      //
      // Measured on the live service (A2-203): 3 client attempts x 2 server
      // attempts = 6 consecutive failures past a threshold of 5, so one caller
      // with a short budget closed `orq:deepseek-v4-pro` for every other caller
      // for ~30 s.
      //
      // It stays narrow deliberately. A caller cannot disable the breaker by
      // asking for MORE time than we allow (that timeout is ours and still
      // counts), and it cannot hide any other failure: only `timeout` takes
      // this branch, so 5xx / auth / parse failures under a short budget open
      // the breaker exactly as before. The attempt is scored neither failure
      // nor success — a success here would wipe an unrelated failure streak.
      const callerTimedOutFirst = errorType === 'timeout' && callerBudgetIsShorter;
      if (!callerTimedOutFirst) {
        modelCb.recordFailure(errorType);
      }
      return {
        id,
        connector: this.name,
        model: request.model || 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs,
        queueWaitMs,
        status: isAbort ? 'timeout' : 'error',
        error: { type: errorType, message, ...action },
      };
    } finally {
      this.activeJobs--;
      this.semaphore.release();
    }
  }

  /**
   * CONN-0232 R10 — path probed for connector reachability. Defaults to
   * `/health`, but a missing `/health` route NO LONGER means offline (see
   * `isReachableStatus`). Override per connector to point at a route the provider
   * actually serves (e.g. `/models`) when `/health` is absent.
   */
  protected getHealthProbePath(): string {
    return '/health';
  }

  /**
   * CONN-0232 R10 — classify a probe HTTP status as "connector reachable".
   * The server ANSWERED, so it is up: 2xx/3xx and 4xx (incl. 401/403 auth-needed
   * and 404 no-such-route) are all reachable. Only 5xx (server erroring) counts
   * as down — except 501 Not Implemented, which still means the server answered.
   *
   * This is the direct fix for openmodel: GET https://api.openmodel.ai/v1/health
   * returns 404 (no route) while /v1/models returns 401 — the API is alive, so a
   * 404 on /health must not blanket-offline every openmodel model.
   */
  protected isReachableStatus(status: number): boolean {
    return status < 500 || status === 501;
  }

  async getStatus(): Promise<ConnectorStatus> {
    const { aggregate, perModel } = this.cbManager.getStates();
    try {
      const res = await fetch(`${this.getBaseUrl()}${this.getHealthProbePath()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });

      const reachable = this.isReachableStatus(res.status);
      return {
        name: this.name,
        // CONN-0244 — `healthy` = connector REACHABLE only. It must NOT fold in the
        // aggregate circuit breaker: `getStates().aggregate` is 'open' whenever ANY
        // single per-model breaker is open, so gating `healthy` on it blanket-offlined
        // the WHOLE provider in the catalog when one model failed (openrouter: a single
        // rate-limited `:free` model offlined all ~350). Per-MODEL availability is
        // computed downstream from `circuitBreakers` (see connectors.service `available`);
        // the aggregate is still surfaced below for observability.
        healthy: reachable,
        activeJobs: this.activeJobs,
        queuedJobs: this.semaphore.pending,
        rateLimitStatus: 'ok',
        circuitBreaker: aggregate,
        circuitBreakers: perModel,
      };
    } catch {
      // Network error / timeout / DNS failure → genuinely unreachable.
      return {
        name: this.name,
        healthy: false,
        activeJobs: this.activeJobs,
        queuedJobs: this.semaphore.pending,
        rateLimitStatus: 'ok',
        circuitBreaker: aggregate,
        circuitBreakers: perModel,
      };
    }
  }

  resetCircuitBreaker(model?: string): CircuitBreakerResetEntry[] {
    const results = model
      ? [this.cbManager.resetModel(model)].filter(Boolean)
      : this.cbManager.resetAll();
    return results.map((r) => ({
      connector: this.name,
      model: r!.model,
      previousState: r!.previousState,
    }));
  }

  protected classifyHttpError(status: number, body: string): string {
    if (status === 429) return 'rate_limited';
    if (status === 401 || status === 403) return 'auth_error';
    if (this.isAuthErrorBody(body)) return 'auth_error';
    if (status === 400 || status === 422) return 'validation_error';
    if (status === 404) {
      try {
        const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
        const code = parsed.error?.code ?? '';
        const msg = parsed.error?.message ?? '';
        if (code === 'model_not_found' || /model[^a-z]*not[^a-z]*found/i.test(msg)) {
          return 'validation_error';
        }
      } catch {
        if (/model[^a-z]*not[^a-z]*found/i.test(body)) return 'validation_error';
      }
    }
    if (status >= 500) return 'server_error';
    return 'http_error';
  }

  // CONN-0050 — some providers signal an invalid/expired API key on a status
  // code that isn't 401/403 (e.g. 400 "Incorrect API key provided"). Mirrors
  // the body-string fallback base-cli.connector.ts already applies to CLI
  // stderr/stdout via classifyError().
  private isAuthErrorBody(body: string): boolean {
    const AUTH_KEYWORDS = /invalid api key|incorrect api key|unauthorized|authentication.*fail/i;
    try {
      const parsed = JSON.parse(body) as {
        error?: { code?: string; type?: string; message?: string };
      };
      const code = (parsed.error?.code ?? '').toLowerCase();
      const type = (parsed.error?.type ?? '').toLowerCase();
      const message = parsed.error?.message ?? '';
      if (code.includes('invalid_api_key') || type.includes('authentication')) return true;
      return AUTH_KEYWORDS.test(message);
    } catch {
      return AUTH_KEYWORDS.test(body);
    }
  }
}
