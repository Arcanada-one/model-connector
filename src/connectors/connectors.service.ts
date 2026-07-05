import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CircuitBreakerResetEntry,
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
import {
  buildDerivedTags,
  entryMatchesFilters,
  type CatalogFilters,
  type CatalogModelEntry,
  type CatalogResponse,
  type ModelModality,
  type ModelPricing,
} from './dto/catalog.dto';
import { ModalityCatalogService } from './modality-catalog.service';

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
  ) {}

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
   * CONN-0226 — Build a catalog of all models across registered connectors.
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
  async getCatalog(filters: CatalogFilters): Promise<CatalogResponse> {
    const entries: CatalogModelEntry[] = [];

    for (const connector of this.connectors.values()) {
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
          tags: buildDerivedTags({ modality, free, cheap, capabilities }),
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
          available: present.executableHere && reachable && !modelBreakerOpen,
        };

        if (entryMatchesFilters(entry, filters)) entries.push(entry);
      }
    }

    // CONN-0232: merge non-chat families (image-gen / STT / TTS) that are not
    // IConnector and therefore invisible to the loop above. Same filters apply.
    entries.push(...this.modalityCatalog.getFilteredEntries(filters));

    return {
      models: entries,
      generatedAt: new Date().toISOString(),
      count: entries.length,
    };
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
    switch (modality) {
      case 'speech_to_text':
      case 'text_to_speech':
      case 'image_generation':
      case 'video':
        return false;
      default:
        // chat, embedding, rerank, moderation
        return true;
    }
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

    let maxRetries: number;
    try {
      maxRetries = getConfig().CONNECTOR_MAX_RETRIES;
    } catch {
      maxRetries = 1;
    }
    const totalAttempts = Math.max(1, maxRetries + 1);
    const guardActive = Boolean(request.output_format);

    let lastResponse: ConnectorResponse | undefined;
    let guardReport: OutputGuardReport | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      let response: ConnectorResponse;
      if (guardActive) {
        const outcome = await this.outputGuardMiddleware.wrapExecute(connector, request);
        response = outcome.response;
        if (outcome.report) {
          guardReport = outcome.report;
        }
      } else {
        response = await connector.execute(request);
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
      response.maxAttempts = totalAttempts;
      lastResponse = response;

      // Success — done
      if (response.status === 'success') {
        break;
      }

      // Non-retryable error or last attempt — done.
      // `guard_exhausted` is intentionally NOT in RETRYABLE_ERRORS — the
      // middleware already consumed its retry budget.
      const errorType = response.error?.type ?? '';
      if (!RETRYABLE_ERRORS.has(errorType) || attempt >= totalAttempts) {
        break;
      }

      // Retry with exponential backoff + jitter
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      const jitter = Math.random() * delay * 0.3;
      this.logger.warn(`Retry ${attempt}/${maxRetries} for ${connectorName}: ${errorType}`);
      await new Promise((r) => setTimeout(r, delay + jitter));
    }

    const response = lastResponse!;
    if (guardReport) {
      response.repair_report = guardReport;
    }

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
    this.logRequest(response, request, apiKeyId, guardReport).catch((err) =>
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
}
