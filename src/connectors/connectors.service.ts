import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import {
  CatalogRefreshResult,
  CircuitBreakerResetEntry,
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  IConnector,
  ProviderModelMeta,
  classifyErrorAction,
} from './interfaces/connector.interface';
import { ConnectorJobData } from '../queue/connector-job.processor';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCliConnector } from './base-cli.connector';
import { sanitizeJsonResponse, JsonSanitizeError } from '../core/utils/json-sanitizer';
import { getConfig } from '../config/env.schema';
import { MetricsService } from '../metrics/metrics.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import type { OutputGuardReport } from './output-guard/types';
import { OPENMODEL_CATALOGUE } from './openmodel/openmodel.catalogue';
import { parseProviderAccess, resolveProviderAccess, type ProviderAccess } from './provider-access';
import {
  buildDerivedTags,
  entryMatchesFilters,
  isModalityExecutableHere,
  type CatalogFilters,
  type CatalogModelEntry,
  type CatalogResponse,
  type ModelModality,
  type ModelPricing,
} from './dto/catalog.dto';
import { ModalityCatalogService } from './modality-catalog.service';
// CONN-0245 — DB-as-source-of-truth catalog read path.
import { CatalogRepository, type CatalogRepositoryLike } from './catalog.repository';
import { rowToEntry } from './catalog-mapper';
import { CATALOG_REDIS_CLIENT, type ICatalogRedis } from './catalog-redis.token';
import { ProviderAccessService, type ProviderAccessLike } from './provider-access.service';
import { firstDispatchMeasurementSchema, type FirstDispatchMeasurementV0 } from './dto/execute.dto';
// CONN-1665 — per-API-key access policy (single choke-point enforcement).
import {
  InvalidStoredPolicyError,
  PolicyService,
  type PolicyServiceLike,
} from '../policy/policy.service';
import type { ApiKeyPolicy } from '../policy/policy.schema';
import { providerKeyContext } from '../policy/provider-key.context';
import {
  finalizeFirstDispatchObservationV0,
  reserveFirstDispatchObservationV0,
  type FirstDispatchObservationV0,
  type FirstDispatchReservationV0,
} from './first-dispatch-observation';

// CONN-0238 — capability mask for non-chat families surfaced via a chat connector.
const NO_CAPS = {
  supportsStreaming: false,
  supportsJsonSchema: false,
  supportsTools: false,
} as const;

// CONN-0089: callers may pass guard-only fields alongside the base request.
export type ServiceExecuteRequest = ConnectorRequest & {
  output_format?: 'json' | 'yaml' | 'toml' | 'python' | 'auto';
  schema?: Record<string, unknown>;
  firstDispatchMeasurement?: FirstDispatchMeasurementV0;
};

const RETRYABLE_ERRORS = new Set([
  'json_parse_error',
  'rate_limited',
  'timeout',
  'server_error',
  'execution_error',
  'network_error',
  'spawn_error',
  'parse_error',
  'http_error',
  'api_error',
  'structured_output_error',
]);

type FirstDispatchFailureStage = 'connector_or_response_processing' | 'observation_finalize';

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  private connectors = new Map<string, IConnector>();

  constructor(
    @InjectQueue('connector-jobs') private readonly jobQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly outputGuardMiddleware: OutputGuardMiddleware,
    // CONN-0232 — static non-chat catalog (image-gen / STT / TTS). Defaulted so
    // existing manual constructions still work; the module provides the real one.
    private readonly modalityCatalog: ModalityCatalogService = new ModalityCatalogService(),
    // CONN-0245 — DB-as-source-of-truth catalog read path. `catalogRepo` is
    // typed as the narrow `CatalogRepositoryLike` interface (so specs can
    // inject a `{ findAll: vi.fn() }` mock), but the interface type is erased
    // at runtime — Nest's automatic DI can't derive a token from it, so
    // `@Inject(CatalogRepository)` supplies the concrete class as the
    // resolution token explicitly. Defaulted to a narrow no-op mock so
    // existing manual `new ConnectorsService(...)` constructions (specs that
    // don't exercise getCatalog/buildCatalogSnapshot) keep working unchanged.
    @Inject(CatalogRepository)
    private readonly catalogRepo: CatalogRepositoryLike = { findAll: async () => [] },
    // Optional Redis accelerator cache in front of the DB read path. `null`
    // (default) disables caching — getCatalog() falls through straight to
    // the repo, which is exactly the pre-cache behavior existing specs expect.
    @Inject(CATALOG_REDIS_CLIENT) private readonly catalogRedis: ICatalogRedis | null = null,
    // CONN-0245-EXT — DB-backed runtime state for CONN-0244's per-provider
    // READ/USE access (`getAccess`/`canRead`/`canUse` below delegate to
    // `this.providerAccess.getAccess(name)`). Defaulted to a stub that
    // replicates CONN-0244's ORIGINAL raw fallback (env `PROVIDER_ACCESS`
    // present-key check, then `getConfig()`, then the hardcoded
    // `'openmodel:read'` default) so every existing manual
    // `new ConnectorsService(...)` construction — including CONN-0244's own
    // spec suite, which sets `process.env.PROVIDER_ACCESS` directly without
    // constructing a ProviderAccessService — keeps working byte-identically.
    @Inject(ProviderAccessService)
    private readonly providerAccess: ProviderAccessLike = {
      seedDefaults: async () => {},
      refresh: async () => {},
      getAccess: (name: string): ProviderAccess => {
        let csv: string;
        if ('PROVIDER_ACCESS' in process.env) {
          csv = process.env.PROVIDER_ACCESS ?? '';
        } else {
          try {
            csv = getConfig().PROVIDER_ACCESS;
          } catch {
            csv = 'openmodel:read';
          }
        }
        return resolveProviderAccess(parseProviderAccess(csv), name);
      },
    },
    // CONN-1665 — per-key access policy. Defaulted to a permissive no-op
    // (null policy = legacy unrestricted) so existing manual
    // `new ConnectorsService(...)` constructions keep working unchanged; the
    // module provides the real PolicyService.
    @Inject(PolicyService)
    private readonly policyService: PolicyServiceLike = {
      getPolicyForKey: async () => null,
      isProviderAllowed: () => true,
      isModelAllowed: () => ({ allowed: true }),
      getTier: async () => undefined,
      resolveProviderKeyEnv: () => null,
      invalidateKey: () => undefined,
    },
  ) {}

  // CONN-0244 — per-provider access (READ = catalog-visible, USE = routable).
  // CONN-0245-EXT — delegates to ProviderAccessService: DB state if the
  // provider has been seeded, else the exact CONN-0244 config computation
  // (see the constructor default above for the pre-seed/unwired fallback).
  private getAccess(name: string): ProviderAccess {
    return this.providerAccess.getAccess(name);
  }

  /** Provider's models are visible in the catalog. */
  canRead(name: string): boolean {
    return this.getAccess(name).read;
  }

  /** MC will route traffic through this provider (cascade / execute). */
  canUse(name: string): boolean {
    return this.getAccess(name).use;
  }

  /**
   * CONN-1665 — the caller's per-key access policy (null = legacy
   * unrestricted key). Throws {@link InvalidStoredPolicyError} on a malformed
   * stored policy — callers must fail closed, never fall back to unrestricted.
   */
  async getKeyPolicy(apiKeyId: string): Promise<ApiKeyPolicy | null> {
    return this.policyService.getPolicyForKey(apiKeyId);
  }

  /**
   * CONN-1665 — candidate-level policy check used by the failover/cascade
   * routers to filter candidate lists BEFORE dispatch, so an all-denied list
   * surfaces an explicit policy_violation instead of a generic exhausted
   * error. Attribution only — the execute() choke point below remains the
   * hard guarantee.
   */
  async isCandidateAllowedByPolicy(
    policy: ApiKeyPolicy,
    connector: string,
    model: string,
  ): Promise<boolean> {
    if (!this.policyService.isProviderAllowed(policy, connector)) return false;
    const tier =
      policy.models?.mode === 'free-only'
        ? await this.policyService.getTier(connector, model)
        : undefined;
    return this.policyService.isModelAllowed(policy, connector, model, tier).allowed;
  }

  /** CONN-1665 — uniform error envelope for policy/config denials at the choke point. */
  private policyErrorResponse(
    connectorName: string,
    model: string | undefined,
    type: 'policy_violation' | 'config_error',
    message: string,
  ): ConnectorResponse {
    const action = classifyErrorAction(type);
    return {
      id: '',
      connector: connectorName,
      model: model || 'unknown',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: 0,
      status: 'error',
      error: { type, message, ...action },
    };
  }

  register(connector: IConnector) {
    this.connectors.set(connector.name, connector);
    this.logger.log(`Registered connector: ${connector.name} (${connector.type})`);
  }

  get(name: string): IConnector {
    const connector = this.connectors.get(name);
    if (!connector) {
      throw new NotFoundException(`Connector "${name}" not found`);
    }
    return connector;
  }

  listNames(): string[] {
    return Array.from(this.connectors.keys());
  }

  /**
   * Dynamic-provider identity is independent of the current refresh result.
   * CatalogRefreshService uses this to avoid relabeling a failed provider's
   * in-memory dynamic cache as immutable static provenance.
   */
  listDynamicCatalogProviderNames(): string[] {
    return Array.from(this.connectors.values())
      .filter((connector) => typeof connector.refreshCatalogModels === 'function')
      .map((connector) => connector.name);
  }

  /**
   * CONN-0243 — in-memory snapshot of every registered connector's capabilities.
   * Used by the failover gateway to build its free-first candidate list WITHOUT the
   * per-connector network `getStatus()` probes that `getCatalog()` performs (R-F3).
   */
  listCapabilities(): ConnectorCapabilities[] {
    return Array.from(this.connectors.values()).map((c) => c.getCapabilities());
  }

  /**
   * CONN-1665 — capabilities view filtered by the caller's per-key policy
   * (GET /v1/models). Legacy keys (no policy) and calls without a key id see
   * the full list. Under 'free-only' the tier comes from the CATALOG
   * (PolicyService.getTier); models with unknown tier are OMITTED
   * (fail-closed). A malformed stored policy exposes nothing.
   */
  async listCapabilitiesForKey(apiKeyId?: string): Promise<ConnectorCapabilities[]> {
    const all = this.listCapabilities();
    if (!apiKeyId) return all;
    let policy: ApiKeyPolicy | null;
    try {
      policy = await this.policyService.getPolicyForKey(apiKeyId);
    } catch {
      return [];
    }
    if (!policy) return all;

    const out: ConnectorCapabilities[] = [];
    for (const caps of all) {
      if (!this.policyService.isProviderAllowed(policy, caps.name)) continue;
      if (!policy.models || policy.models.mode === 'all') {
        out.push(caps);
        continue;
      }
      const metas: ProviderModelMeta[] = caps.modelMeta?.length
        ? caps.modelMeta
        : caps.models.map((id) => ({ id }));
      const allowedMetas: ProviderModelMeta[] = [];
      for (const meta of metas) {
        const tier =
          policy.models.mode === 'free-only'
            ? await this.policyService.getTier(caps.name, meta.id)
            : undefined;
        if (this.policyService.isModelAllowed(policy, caps.name, meta.id, tier).allowed) {
          allowedMetas.push(meta);
        }
      }
      if (!allowedMetas.length) continue;
      const allowedIds = new Set(allowedMetas.map((m) => m.id));
      out.push({
        ...caps,
        models: [...allowedIds],
        ...(caps.modelMeta?.length ? { modelMeta: allowedMetas } : {}),
        ...(caps.freeModels
          ? { freeModels: caps.freeModels.filter((id) => allowedIds.has(id)) }
          : {}),
      });
    }
    return out;
  }

  async listAll(): Promise<
    Array<{ name: string; type: string; capabilities: ReturnType<IConnector['getCapabilities']> }>
  > {
    return Array.from(this.connectors.values()).map((c) => ({
      name: c.name,
      type: c.type,
      capabilities: c.getCapabilities(),
    }));
  }

  /**
   * CONN-0245 — Build a FULL, unfiltered catalog snapshot across all
   * registered connectors. This is the exact CONN-0226 assembly logic
   * (unchanged), just no longer invoked on the request path: the ONLY
   * caller is CatalogRefreshService's cron, which persists the result via
   * `entryToRow` + `CatalogRepository.applyProviderSnapshot()`. `getCatalog()`
   * below never calls this — it reads the DB (+ optional cache) instead.
   *
   * Price / free detection strategy per connector:
   *  - openmodel: uses OPENMODEL_CATALOGUE price_multiplier (0 = free).
   *  - all connectors: if freeModels[] is present on capabilities, those
   *    model ids are marked free regardless of catalogue.
   *  - connectors that expose no price data → priceMultiplier: null.
   *
   * Rate limits (RPM/TPM): no connector currently exposes these; always null.
   * Never invent values — callers must treat null as "unknown".
   */
  async buildCatalogSnapshot(): Promise<CatalogModelEntry[]> {
    const entries: CatalogModelEntry[] = [];

    for (const connector of this.connectors.values()) {
      // CONN-0244 — READ gate: a provider with read=false is hidden from the catalog entirely.
      // USE gate: read-only providers stay visible but are marked not-routable below.
      const access = this.getAccess(connector.name);
      if (!access.read) continue;
      const routable = access.use;
      const caps = connector.getCapabilities();
      let status: ConnectorStatus;
      try {
        status = await connector.getStatus();
      } catch {
        status = {
          name: connector.name,
          healthy: false,
          activeJobs: 0,
          queuedJobs: 0,
          rateLimitStatus: 'ok',
        };
      }

      // CONN-0232/0244: `healthy` means the connector is REACHABLE (R10 — a 404 on a
      // missing /health route no longer marks a live API offline; CONN-0244 — an open
      // per-model breaker no longer flips `healthy`). Per-model availability additionally
      // requires the model's own circuit breaker to be closed (see `modelBreakerOpen`
      // below), so neither a probe quirk nor one failing model blanket-offlines the rest.
      const reachable = status.healthy;
      const perModelBreakers = status.circuitBreakers ?? {};
      // CONN-0232: connector-wide default modality (chat) unless the connector
      // declares one (e.g. embedding). Never overloads transport `type`.
      const connectorModality: ModelModality = caps.modality ?? 'chat';
      const freeModelSet = new Set<string>(caps.freeModels ?? []);
      // CONN-0238: per-model metadata (modality/pricing/context/free). Derived from
      // the same source as `models`, so iterate metas when NON-EMPTY (single source —
      // no drift); otherwise wrap the flat id list. The `.length` guard (not just
      // `??`) means a connector that returns `modelMeta: []` does not silently yield
      // a zero-model catalog when `models` still has ids (consilium impl-review MED).
      const metaList: ProviderModelMeta[] = caps.modelMeta?.length
        ? caps.modelMeta
        : caps.models.map((id) => ({ id }));

      for (const meta of metaList) {
        const model = meta.id;
        const modality: ModelModality = meta.modality ?? connectorModality;
        const priceMultiplier = this.resolvePrice(connector.name, model);
        const free =
          meta.free ??
          (freeModelSet.has(model) || (priceMultiplier !== null && priceMultiplier === 0));
        const cheap = free || (priceMultiplier !== null && priceMultiplier <= 1);
        const modelBreakerOpen = perModelBreakers[model]?.state === 'open';

        // CONN-0238 — present each model HONESTLY per modality (consilium HIGH):
        // a chat connector cannot execute its non-chat families via /execute, so
        // they carry no chat capabilities, point at their real sibling-module
        // endpoint, and are not claimed callable. chat + moderation (groq
        // prompt-guard is served via chat/completions) keep the connector caps.
        const present = this.presentModel(modality, {
          supportsStreaming: caps.supportsStreaming,
          supportsJsonSchema: caps.supportsJsonSchema,
          supportsTools: caps.supportsTools,
        });
        const capabilities = present.capabilities;
        const pricing: ModelPricing | null = meta.pricing ?? null;

        const entry: CatalogModelEntry = {
          connector: connector.name,
          model,
          modality,
          tags: buildDerivedTags({ modality, free, cheap, capabilities, routable }),
          free,
          cheap,
          priceMultiplier,
          pricing,
          contextWindow: meta.contextWindow ?? null,
          maxOutputTokens: meta.maxOutputTokens ?? null,
          // Rate limits: no connector exposes live machine RPM/TPM data yet.
          rateLimits: null,
          capabilities,
          routing: {
            connector: connector.name,
            model,
            ...(present.endpoint ? { endpoint: present.endpoint } : {}),
          },
          // CONN-0244 — a read-only provider (routable=false) is never `available` for routing.
          available: routable && present.executableHere && reachable && !modelBreakerOpen,
        };

        entries.push(entry);
      }
    }

    // CONN-0232: merge non-chat families (image-gen / STT / TTS) that are not
    // IConnector and therefore invisible to the loop above. Unfiltered — this
    // is a full snapshot, not a request-scoped view.
    entries.push(...this.modalityCatalog.getEntries());

    return entries;
  }

  /**
   * CONN-0245 — Universal model catalog, READ-ONLY from the DB (+ optional
   * short-TTL Redis cache in front of it). Never calls a provider on this
   * path — the `model_catalog` table is the single source of truth, kept
   * warm by `CatalogRefreshService`'s cron (full refresh + status interval).
   *
   * CONN-1665 — when `apiKeyId` is provided, the response is additionally
   * filtered by that key's access policy (consilium decision: discovery
   * surfaces mirror the enforcement so a client never sees a model it cannot
   * call). Filtering happens AFTER the shared cache read/write so the cache
   * stays per-filter, never per-key.
   */
  async getCatalog(filters: CatalogFilters, apiKeyId?: string): Promise<CatalogResponse> {
    const cacheEnabled = this.isCatalogCacheEnabled();
    const cacheKey = this.catalogCacheKey(filters);

    if (cacheEnabled && this.catalogRedis) {
      try {
        const cached = await this.catalogRedis.get(cacheKey);
        if (cached) {
          const response = JSON.parse(cached) as CatalogResponse;
          const models = response.models.filter((entry) => this.canRead(entry.connector));
          return this.applyPolicyToCatalog({ ...response, models, count: models.length }, apiKeyId);
        }
      } catch {
        this.logger.warn('catalog cache read failed; falling back to DB');
      }
    }

    const rows = await this.catalogRepo.findAll();
    const visibleRows = rows.filter((row) => this.canRead(row.connector));
    const entries = visibleRows
      .map((row) => rowToEntry(row))
      .filter((entry) => entryMatchesFilters(entry, filters));
    const generatedAt = visibleRows.length
      ? new Date(Math.max(...visibleRows.map((r) => r.lastChecked.getTime()))).toISOString()
      : new Date().toISOString();

    const response: CatalogResponse = {
      models: entries,
      generatedAt,
      count: entries.length,
    };

    if (cacheEnabled && this.catalogRedis) {
      try {
        await this.catalogRedis.set(
          cacheKey,
          JSON.stringify(response),
          'PX',
          this.catalogCacheTtlMs(),
        );
      } catch {
        this.logger.warn('catalog cache write failed; continuing without cache');
      }
    }

    return this.applyPolicyToCatalog(response, apiKeyId);
  }

  /**
   * CONN-1665 — per-key policy view on the catalog. Provider gate + model
   * gate. Under 'free-only' the catalog row itself is the tier source of
   * truth: `entry.free` is persisted by `deriveTier()` (free ⇔ tier 'free';
   * an 'unknown' tier persists free=false), so unknown-tier models are
   * OMITTED — the same fail-closed semantics as the execute() choke point.
   * A malformed stored policy exposes nothing (fail-closed).
   */
  private async applyPolicyToCatalog(
    response: CatalogResponse,
    apiKeyId?: string,
  ): Promise<CatalogResponse> {
    if (!apiKeyId) return response;
    let policy: ApiKeyPolicy | null;
    try {
      policy = await this.policyService.getPolicyForKey(apiKeyId);
    } catch {
      return { ...response, models: [], count: 0 };
    }
    if (!policy) return response;

    const models = response.models.filter((entry) => {
      if (!this.policyService.isProviderAllowed(policy, entry.connector)) return false;
      if (!policy.models || policy.models.mode === 'all') return true;
      if (policy.models.mode === 'list') return (policy.models.list ?? []).includes(entry.model);
      // free-only
      return entry.free === true;
    });
    return { ...response, models, count: models.length };
  }

  private isCatalogCacheEnabled(): boolean {
    // Defensive getConfig (matches the cascade-router convention): when the
    // full env can't be validated (e.g. unit tests without DATABASE_URL) fall
    // back to the env.schema default (true) rather than silently disabling the
    // cache path. Prod always has a validated config, so it reads the real flag.
    try {
      return getConfig().CATALOG_CACHE_ENABLED;
    } catch {
      return true;
    }
  }

  private catalogCacheTtlMs(): number {
    try {
      return getConfig().CATALOG_CACHE_TTL_MS;
    } catch {
      return 30_000;
    }
  }

  /** Stable cache key — sorted-key JSON hashed so semantically-identical filter objects collide. */
  private catalogCacheKey(filters: CatalogFilters): string {
    const sortedEntries = Object.entries(filters as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    const stable = JSON.stringify(sortedEntries);
    const hash = createHash('sha1').update(stable).digest('hex');
    return `conn:catalog:${hash}`;
  }

  /**
   * CONN-0238 — per-modality presentation policy for a model surfaced through a
   * chat IConnector. Chat + moderation are executable via the connector's chat path
   * (groq prompt-guard runs through chat/completions), so they keep the connector's
   * capabilities and the default /execute route. The non-chat families (STT/TTS/
   * image/video) are surfaced for catalog COMPLETENESS (operator: "show them all")
   * but the chat connector CANNOT execute them — they carry no chat capabilities,
   * point at their honest sibling-module endpoint where one exists, and are marked
   * not-executable-here (`available:false`). This keeps the catalog truthful
   * (anti-fabrication) without dropping the families the operator wants shown.
   */
  private presentModel(
    modality: ModelModality,
    connectorCaps: {
      supportsStreaming: boolean;
      supportsJsonSchema: boolean;
      supportsTools: boolean;
    },
  ): {
    capabilities: {
      supportsStreaming: boolean;
      supportsJsonSchema: boolean;
      supportsTools: boolean;
    };
    endpoint?: string;
    executableHere: boolean;
  } {
    const executableHere = ConnectorsService.isModalityExecutableHere(modality);
    // STT/TTS/image/video surfaced through a chat connector are INFORMATIONAL —
    // the (connector, model) tuple is not a real route here (the executable row is
    // the dedicated modality connector, e.g. `groq-stt`). We set NO chat caps, mark
    // not-callable-here, and DELIBERATELY OMIT `routing.endpoint`: pointing it at a
    // sibling module's path would misrepresent the route (consilium impl-review MED
    // — `/v1/speech/stt` with `connector:groq` is not how you call it; grok-imagine
    // ids are not wired into MC's image module at all). `available:false` + the
    // modality is the honest signal; route via the dedicated connector for that
    // modality, not this one.
    //
    // moderation (groq prompt-guard) IS callable here — it runs through the chat
    // /execute → /chat/completions path — but it is a classifier, so it carries NO
    // chat capabilities (no tools/json-schema/streaming) to keep `cap:*` honest.
    if (modality === 'moderation' || !executableHere) {
      return { capabilities: { ...NO_CAPS }, executableHere };
    }
    return { capabilities: connectorCaps, executableHere };
  }

  /**
   * CONN-0239 — single source of truth for "can this modality run through the chat
   * `/execute` path of an IConnector?". Chat / embedding / rerank / moderation are
   * served via the connector's chat path; the dedicated-pipeline modalities
   * (STT / TTS / image / video) are NOT — calling them via /execute would forward a
   * non-chat id to /chat/completions. Used by {@link presentModel} (catalog
   * `available`) AND the execute() pre-flight gate so the two never drift.
   */
  static isModalityExecutableHere(modality: ModelModality): boolean {
    return isModalityExecutableHere(modality);
  }

  /**
   * Resolve a price multiplier for a given connector + model combination.
   * Returns null when no price data is available for this connector.
   * Currently only openmodel exposes structured price data via OPENMODEL_CATALOGUE.
   */
  private resolvePrice(connectorName: string, model: string): number | null {
    if (connectorName === 'openmodel') {
      const entry = OPENMODEL_CATALOGUE.find((e) => e.id === model);
      return entry !== undefined ? entry.price_multiplier : null;
    }
    return null;
  }

  async getStatus(name: string): Promise<ConnectorStatus> {
    return this.get(name).getStatus();
  }

  /**
   * CONN-1646 — invoke the explicit dynamic-catalog contract for every
   * readable provider that implements it. Each result identifies success or
   * failure without reclassifying an in-memory cached dynamic catalog as a
   * static floor. Unexpected throws become a sanitized controlled failure;
   * providers refresh independently.
   */
  async refreshAllProviderModels(): Promise<Map<string, CatalogRefreshResult>> {
    const refreshable = Array.from(this.connectors.values()).filter(
      (
        connector,
      ): connector is IConnector & {
        refreshCatalogModels: () => Promise<CatalogRefreshResult>;
      } => this.canRead(connector.name) && typeof connector.refreshCatalogModels === 'function',
    );
    const results = new Map<string, CatalogRefreshResult>();
    await Promise.all(
      refreshable.map(async (connector) => {
        try {
          results.set(connector.name, await connector.refreshCatalogModels());
        } catch {
          this.logger.warn(`catalog model refresh failed for ${connector.name}: reason=unexpected`);
          results.set(connector.name, {
            status: 'failed',
            source: 'provider-api',
            checkedAt: new Date(),
            reason: 'unexpected',
          });
        }
      }),
    );
    return results;
  }

  resetCircuitBreaker(connectorName?: string, model?: string): CircuitBreakerResetEntry[] {
    if (connectorName) {
      return this.get(connectorName).resetCircuitBreaker(model);
    }
    const results: CircuitBreakerResetEntry[] = [];
    for (const connector of this.connectors.values()) {
      results.push(...connector.resetCircuitBreaker(model));
    }
    return results;
  }

  async execute(
    connectorName: string,
    request: ServiceExecuteRequest,
    apiKeyId: string,
  ): Promise<ConnectorResponse> {
    const connector = this.get(connectorName);

    // CONN-0244 — USE gate (single choke-point for ALL routing: direct /execute, universal
    // /execute, and every cascade candidate route through here). A read-only provider is never
    // routed to — reject before any outbound call so a provider the operator marked not-routable
    // (e.g. paid OpenModel) cannot burn money. Permanent (non-retryable) so the cascade advances.
    if (!this.canUse(connectorName)) {
      const action = classifyErrorAction('provider_not_routable');
      return {
        id: '',
        connector: connectorName,
        model: request.model || 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs: 0,
        status: 'error',
        error: {
          type: 'provider_not_routable',
          message: `Connector '${connectorName}' is READ-only (PROVIDER_ACCESS): its models are visible in the catalog but MC does not route traffic to it.`,
          ...action,
        },
      };
    }

    // CONN-1665 — per-key policy gates, adjacent to the CONN-0244 canUse() gate
    // at the same single choke point (direct /execute, universal /execute and
    // every failover/cascade candidate all route through here). AND semantics:
    // the global gate above already denied non-routable providers; a per-key
    // policy can only NARROW further, never widen past a global deny.
    let policy: ApiKeyPolicy | null;
    try {
      policy = await this.policyService.getPolicyForKey(apiKeyId);
    } catch (err) {
      if (err instanceof InvalidStoredPolicyError) {
        // Fail closed. Details (incl. the key id) are logged by PolicyService;
        // the client-facing message stays generic.
        return this.policyErrorResponse(
          connectorName,
          request.model,
          'config_error',
          'The access policy stored for this API key is invalid; contact the administrator.',
        );
      }
      throw err;
    }
    if (policy) {
      if (!this.policyService.isProviderAllowed(policy, connectorName)) {
        return this.policyErrorResponse(
          connectorName,
          request.model,
          'policy_violation',
          `Provider '${connectorName}' is not permitted by this API key's access policy.`,
        );
      }
      if (policy.models && policy.models.mode !== 'all') {
        if (!request.model) {
          return this.policyErrorResponse(
            connectorName,
            request.model,
            'policy_violation',
            `This API key's access policy restricts models on provider '${connectorName}', ` +
              `but the request did not name a model (fail-closed).`,
          );
        }
        // Tier comes from the CATALOG (deriveTier-persisted), NEVER from a
        // ':free' id suffix (would reopen the CONN-0244 false-free bug).
        const tier =
          policy.models.mode === 'free-only'
            ? await this.policyService.getTier(connectorName, request.model)
            : undefined;
        const decision = this.policyService.isModelAllowed(
          policy,
          connectorName,
          request.model,
          tier,
        );
        if (!decision.allowed) {
          return this.policyErrorResponse(
            connectorName,
            request.model,
            'policy_violation',
            decision.reason ??
              `Model '${request.model}' is not permitted by this API key's access policy.`,
          );
        }
      }
    }

    // CONN-1665 — per-key provider-key override: resolve the policy's env
    // NAME to a key VALUE. A missing/empty env var fails LOUD (config_error)
    // — never a silent fallback to the shared provider key. The env var NAME
    // is logged server-side only and never appears in the client message.
    let providerKeyOverride: { provider: string; apiKey: string } | null = null;
    if (policy) {
      const envName = this.policyService.resolveProviderKeyEnv(policy, connectorName);
      if (envName) {
        const value = process.env[envName];
        if (!value) {
          this.logger.error(
            `Provider key alias for '${connectorName}' (env var ${envName}) is not configured — denying request for key ${apiKeyId}`,
          );
          return this.policyErrorResponse(
            connectorName,
            request.model,
            'config_error',
            `Provider key alias for '${connectorName}' is not configured on the server; contact the administrator.`,
          );
        }
        providerKeyOverride = { provider: connectorName, apiKey: value };
      }
    }

    // CONN-0239 — modality pre-flight gate. The catalog surfaces non-chat families
    // (STT/TTS/image/video) for completeness with `available:false`; this connector's
    // chat `/execute` path cannot serve them. Reject such a request HERE with
    // `unsupported_modality` instead of forwarding a non-chat id to /chat/completions
    // (which would burn a provider round-trip for a provider-side error). Resolved
    // from the same per-model modality the catalog uses — single source via
    // `isModalityExecutableHere`. When the model is unknown to modelMeta we do NOT
    // block (default chat assumption) — only a KNOWN non-executable modality is gated.
    if (request.model) {
      const caps = connector.getCapabilities();
      const meta = caps.modelMeta?.find((m) => m.id === request.model);
      const modality = meta?.modality;
      if (modality && !ConnectorsService.isModalityExecutableHere(modality)) {
        const action = classifyErrorAction('unsupported_modality');
        return {
          id: '',
          connector: connectorName,
          model: request.model,
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 0,
          status: 'error',
          error: {
            type: 'unsupported_modality',
            message: `Model '${request.model}' is a '${modality}' model and cannot be executed through the chat endpoint of connector '${connectorName}'. Route it via the dedicated ${modality} connector instead.`,
            ...action,
          },
        };
      }
    }

    // CONN-0243 — a per-request `maxRetries` (e.g. 0 from the failover gateway) overrides
    // the service-level CONNECTOR_MAX_RETRIES so the outer free-first chain owns retry/advance
    // and the inner loop does not compound exponential backoff on every failover hop.
    let maxRetries: number;
    if (typeof request.maxRetries === 'number') {
      maxRetries = Math.max(0, request.maxRetries);
    } else {
      try {
        maxRetries = getConfig().CONNECTOR_MAX_RETRIES;
      } catch {
        maxRetries = 1;
      }
    }
    const totalAttempts = Math.max(1, maxRetries + 1);
    const { firstDispatchMeasurement, ...providerRequest } = request;
    const validatedMeasurement =
      firstDispatchMeasurement === undefined
        ? undefined
        : firstDispatchMeasurementSchema.parse(firstDispatchMeasurement);
    if (validatedMeasurement !== undefined && providerRequest.output_format !== undefined) {
      throw new BadRequestException('firstDispatchMeasurement cannot use output-guard retries');
    }
    const guardActive = Boolean(providerRequest.output_format);
    const attemptsForRequest = validatedMeasurement === undefined ? totalAttempts : 1;
    const observationReservation = validatedMeasurement
      ? await this.reserveFirstDispatchObservation(
          connectorName,
          providerRequest,
          apiKeyId,
          validatedMeasurement,
        )
      : null;

    let lastResponse: ConnectorResponse | undefined;
    let guardReport: OutputGuardReport | null = null;
    let observationFailureStage: FirstDispatchFailureStage = 'connector_or_response_processing';

    // CONN-1665 — the ENTIRE retry loop runs inside the provider-key ALS
    // context (when the policy names an override), so every attempt —
    // including output-guard wrapped ones — sees the dedicated key. The
    // context is never handed off through the BullMQ queue path (ALS does not
    // survive serialization; that path bypasses all gates and is asserted
    // dead in enqueue-dead-path.spec.ts).
    const runAttempts = async (): Promise<void> => {
      for (let attempt = 1; attempt <= attemptsForRequest; attempt++) {
        let response: ConnectorResponse;
        if (guardActive) {
          const outcome = await this.outputGuardMiddleware.wrapExecute(connector, providerRequest);
          response = outcome.response;
          if (outcome.report) {
            guardReport = outcome.report;
          }
        } else {
          response = await connector.execute(providerRequest);
        }

        // JSON sanitization if responseFormat requested (legacy path).
        if (
          !guardActive &&
          request.responseFormat?.type === 'json_object' &&
          response.status === 'success'
        ) {
          response = this.applySanitization(response);
        }

        response.attempt = attempt;
        response.maxAttempts = attemptsForRequest;
        lastResponse = response;

        // Success — done
        if (response.status === 'success') {
          break;
        }

        // Non-retryable error or last attempt — done.
        // `guard_exhausted` is intentionally NOT in RETRYABLE_ERRORS — the
        // middleware already consumed its retry budget.
        const errorType = response.error?.type ?? '';
        if (!RETRYABLE_ERRORS.has(errorType) || attempt >= attemptsForRequest) {
          break;
        }

        // Retry with exponential backoff + jitter
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        const jitter = Math.random() * delay * 0.3;
        this.logger.warn(`Retry ${attempt}/${maxRetries} for ${connectorName}: ${errorType}`);
        await new Promise((r) => setTimeout(r, delay + jitter));
      }
    };

    try {
      if (providerKeyOverride) {
        await providerKeyContext.run(providerKeyOverride, runAttempts);
      } else {
        await runAttempts();
      }

      let response = lastResponse!;
      if (guardReport) {
        response.repair_report = guardReport;
      }
      if (observationReservation) {
        observationFailureStage = 'observation_finalize';
        const firstDispatchObservation = await this.finalizeFirstDispatchObservation(
          observationReservation,
          response,
        );
        response = { ...response, firstDispatchObservation };
      }
      lastResponse = response;
    } catch (error) {
      if (observationReservation) {
        await this.markFirstDispatchIndeterminate(
          observationReservation,
          observationFailureStage,
        ).catch(() => {
          this.logger.error('Failed to mark first-dispatch observation indeterminate');
        });
      }
      throw error;
    }

    const response = lastResponse!;

    // Metrics recording (per-model)
    this.metricsService.record({
      connector: connectorName,
      model: response.model,
      status: response.status,
      errorType: response.error?.type,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
      latencyMs: response.latencyMs,
      queueWaitMs: response.queueWaitMs,
      attempt: response.attempt,
      outputGuard: guardReport
        ? {
            retries: guardReport.retries,
            finalValid: guardReport.final_valid,
            pass: guardReport.pass,
            strategiesApplied: guardReport.strategies_applied,
          }
        : undefined,
    });

    // Fire-and-forget DB logging
    this.logRequest(response, providerRequest, apiKeyId, guardReport).catch((err) =>
      this.logger.error(`Failed to log request: ${err}`),
    );

    return response;
  }

  private applySanitization(response: ConnectorResponse): ConnectorResponse {
    try {
      const result = sanitizeJsonResponse(response.result);
      return {
        ...response,
        result: result.sanitized,
        structured: result.json,
      };
    } catch (err) {
      const action = classifyErrorAction('json_parse_error');
      return {
        ...response,
        status: 'error',
        error: {
          type: 'json_parse_error',
          message: err instanceof JsonSanitizeError ? err.message : 'Failed to parse JSON response',
          ...action,
        },
      };
    }
  }

  async enqueue(
    connectorName: string,
    request: ConnectorRequest,
    apiKeyId: string,
  ): Promise<string> {
    this.get(connectorName); // validate exists
    const job = await this.jobQueue.add('execute', {
      connectorName,
      request,
      apiKeyId,
    } satisfies ConnectorJobData);
    return job.id!;
  }

  private async logRequest(
    response: ConnectorResponse,
    request: ConnectorRequest,
    apiKeyId: string,
    repairReport: OutputGuardReport | null = null,
  ) {
    const digest = BaseCliConnector.promptDigest(request.prompt);
    await this.prisma.request.create({
      data: {
        connector: response.connector,
        model: response.model,
        promptHash: digest.promptHash,
        promptLength: digest.promptLength,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        costUsd: response.usage.costUsd,
        latencyMs: response.latencyMs,
        status: response.status,
        errorType: response.error?.type,
        errorMessage: response.error?.message?.slice(0, 500),
        apiKeyId,
        repairReport: repairReport ? (repairReport as unknown as object) : undefined,
      },
    });
  }

  private async reserveFirstDispatchObservation(
    connectorName: string,
    providerRequest: ConnectorRequest,
    apiKeyId: string,
    measurement: FirstDispatchMeasurementV0,
  ): Promise<FirstDispatchReservationV0> {
    const reservation = reserveFirstDispatchObservationV0({
      observationId: randomUUID(),
      apiKeyId,
      measurement,
      connector: connectorName,
      providerRequest,
    });
    await this.prisma.firstDispatchObservation.create({
      data: {
        id: reservation.observationId,
        apiKeyId,
        observationKeySha256: reservation.observationKeySha256,
        measurement: reservation.measurement as unknown as object,
        connector: reservation.connector,
        requestedModel: reservation.requestedModel,
        requestPayloadDigestSha256: reservation.requestPayloadDigestSha256,
        requestPayloadBytes: reservation.requestPayloadBytes,
        observationBoundary: reservation.observationBoundary,
        persistence: 'MODEL_CONNECTOR_POSTGRESQL',
        evidenceStatus: 'RESERVED_PRE_ADAPTER_OBSERVATION',
        authorization: 'NOT_AUTHORIZED',
        state: 'reserved',
      },
    });
    return reservation;
  }

  private async finalizeFirstDispatchObservation(
    reservation: FirstDispatchReservationV0,
    response: ConnectorResponse,
  ): Promise<FirstDispatchObservationV0> {
    const observation = finalizeFirstDispatchObservationV0(reservation, response);
    const updated = await this.prisma.firstDispatchObservation.updateMany({
      where: { id: reservation.observationId, state: 'reserved' },
      data: {
        connectorResponseId: observation.connectorResponseId,
        observedModel: observation.model,
        inputTokens: observation.usage.inputTokens,
        outputTokens: observation.usage.outputTokens,
        totalTokens: observation.usage.totalTokens,
        costUsd: observation.usage.costUsd,
        latencyMs: observation.latencyMs,
        outcome: observation.outcome,
        usageSource: observation.usage.source,
        persistence: observation.persistence,
        evidenceStatus: observation.evidenceStatus,
        authorization: observation.authorization,
        receipt: observation as unknown as object,
        receiptDigestSha256: observation.receiptDigestSha256,
        state: 'observed',
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('first-dispatch observation is missing or already finalized');
    }
    return observation;
  }

  private async markFirstDispatchIndeterminate(
    reservation: FirstDispatchReservationV0,
    failureStage: FirstDispatchFailureStage,
  ): Promise<void> {
    await this.prisma.firstDispatchObservation.updateMany({
      where: { id: reservation.observationId, state: 'reserved' },
      data: {
        state: 'indeterminate',
        evidenceStatus: 'INDETERMINATE_PROVIDER_OR_PERSISTENCE_OUTCOME',
        failureStage,
      },
    });
  }
}
