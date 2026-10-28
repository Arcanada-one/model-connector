// CONN-0223 — Cascade router: ordered free→paid connector fallback.
// NO fetch/axios/http in this file — all HTTP is delegated to ConnectorsService.

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConnectorsService } from '../connectors.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  ConnectorRequest,
  ConnectorResponse,
  classifyErrorAction,
} from '../interfaces/connector.interface';
import { buildLowReasoningCandidates, CascadeCandidate } from './cascade.profiles';
import { CascadeExhaustedError, CascadeBudgetExceededError } from './cascade.errors';
import { getConfig } from '../../config/env.schema';
import { DEFAULT_CHAIN_DEADLINE_MS } from '../../config/chain-deadline';
import { configuredHopTimeoutMs } from '../attempt-budget';
import { ChainDeadlineError } from '../failover/failover.errors';
import {
  capHopTimeout,
  chainShouldAdvance,
  responseDeliveredChunk,
} from '../failover/failover.chain';
// CONN-1665 — per-key policy candidate filtering (attribution before dispatch).
import type { ApiKeyPolicy } from '../../policy/policy.schema';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

@Injectable()
export class CascadeRouterService {
  private readonly logger = new Logger(CascadeRouterService.name);

  // In-memory daily paid cost accumulator (no Prisma schema changes required).
  private dailyPaidCostUsd = 0;
  private budgetResetDate: string = todayUtc();

  constructor(
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectorsService: ConnectorsService,
    private readonly metricsService: MetricsService,
  ) {}

  private resetDailyBudgetIfNeeded(): void {
    const today = todayUtc();
    if (today !== this.budgetResetDate) {
      this.dailyPaidCostUsd = 0;
      this.budgetResetDate = today;
    }
  }

  private getCandidates(profile: string): CascadeCandidate[] {
    let config;
    try {
      config = getConfig();
    } catch {
      // Fallback for test environments where env may not be fully loaded
      config = {
        CASCADE_LOW_REASONING_ORDER:
          // CONN-0244 — test-env fallback: a genuinely-free rung (groq free tier), NOT the
          // paid openmodel gateway which must never be a `:free` cascade step.
          process.env.CASCADE_LOW_REASONING_ORDER || 'groq:llama-3.3-70b-versatile:free',
        CASCADE_PAID_ENABLED: false,
        CASCADE_PAID_DAILY_BUDGET_USD: 0.17,
      } as ReturnType<typeof getConfig>;
    }

    if (profile === 'low-reasoning') {
      const candidates = buildLowReasoningCandidates({
        lowReasoningOrder: config.CASCADE_LOW_REASONING_ORDER,
        paidEnabled: config.CASCADE_PAID_ENABLED,
      });
      // Routability is filtered in execute(), after loading the caller's key
      // policy. A provider may be available through that key's mapped secret
      // even when the process-wide default credential is absent.
      return candidates;
    }
    throw new Error(`Unknown cascade profile: "${profile}"`);
  }

  /** CONN-1665 — explicit policy/config denial envelope for the cascade surface. */
  private policyDenialResponse(
    type: 'policy_violation' | 'config_error',
    message: string,
  ): ConnectorResponse {
    const action = classifyErrorAction(type);
    return {
      id: '',
      connector: 'none',
      model: 'none',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: 0,
      status: 'error',
      error: { type, message, ...action },
    };
  }

  private chainDeadlineMs(): number {
    try {
      const configured = getConfig().CHAIN_DEADLINE_MS;
      if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1) {
        return configured;
      }
    } catch {
      // Specs that construct the router without a validated environment.
    }
    return DEFAULT_CHAIN_DEADLINE_MS;
  }

  /**
   * CLI connectors can execute tools and write files before a timeout
   * (gemini, codex, claude-code). An API hop is one HTTP completion. When the
   * registry cannot answer, the hop is not treated as pure.
   */
  private hopTransport(connectorName: string): {
    type: 'cli' | 'api' | 'unknown';
    maxTimeout?: number;
  } {
    if (typeof this.connectorsService.get !== 'function') {
      return { type: 'unknown' };
    }
    try {
      const connector = this.connectorsService.get(connectorName);
      return { type: connector.type, maxTimeout: connector.getCapabilities().maxTimeout };
    } catch {
      return { type: 'unknown' };
    }
  }

  private getBudgetLimitUsd(): number {
    try {
      return getConfig().CASCADE_PAID_DAILY_BUDGET_USD;
    } catch {
      return 0.17;
    }
  }

  async execute(
    profile: string,
    request: Omit<ConnectorRequest, 'connector'>,
    apiKeyId: string,
    clock?: { now?: () => number },
  ): Promise<ConnectorResponse> {
    this.resetDailyBudgetIfNeeded();

    let candidates = this.getCandidates(profile);

    // CONN-1665 — filter cascade candidates by the caller's per-key policy
    // BEFORE dispatch. The ConnectorsService.execute() choke point remains the
    // hard guarantee; this filter provides correct attribution: an all-denied
    // list yields an explicit policy_violation, not a generic exhausted error.
    let policy: ApiKeyPolicy | null = null;
    try {
      policy = await this.connectorsService.getKeyPolicy(apiKeyId);
    } catch {
      // Malformed stored policy — fail closed (details logged by PolicyService).
      return this.policyDenialResponse(
        'config_error',
        'The access policy stored for this API key is invalid; contact the administrator.',
      );
    }

    // Apply the global access gate and this client's exact credential binding
    // before dispatch. This preserves profile-specific credentials without
    // allowing a missing binding to fall back to the shared process key.
    const routable: CascadeCandidate[] = [];
    for (const candidate of candidates) {
      if (await this.connectorsService.canUseForPolicy(candidate.connector, policy)) {
        routable.push(candidate);
      }
    }
    candidates = routable;
    if (candidates.length === 0) {
      return this.policyDenialResponse(
        'config_error',
        'No provider credentials are configured for this request.',
      );
    }

    if (policy) {
      const filtered: CascadeCandidate[] = [];
      for (const c of candidates) {
        if (await this.connectorsService.isCandidateAllowedByPolicy(policy, c.connector, c.model)) {
          filtered.push(c);
        }
      }
      if (filtered.length === 0) {
        return this.policyDenialResponse(
          'policy_violation',
          "No cascade candidates are permitted by this API key's access policy.",
        );
      }
      candidates = filtered;
    }
    const tried: { connector: string; model: string; errorType: string }[] = [];
    const now = clock?.now ?? Date.now;
    const startedAt = now();
    const deadlineMs = this.chainDeadlineMs();
    const startMs = startedAt;
    let fallbackCount = 0;
    let freeTierHit = false;
    let lastHop: ChainDeadlineError['lastHop'] = null;

    for (let i = 0; i < candidates.length; i++) {
      const remaining = deadlineMs - (now() - startedAt);
      if (remaining < 1) {
        const previous = i > 0 ? candidates[i - 1] : undefined;
        this.metricsService.recordCascade({
          connector: previous?.connector ?? 'none',
          model: previous?.model ?? 'none',
          tier: previous?.tier ?? 'free',
          status: 'abort',
          fallbackCount,
          latencyMs: now() - startedAt,
          costUsd: 0,
          freeTierHit,
        });
        throw new ChainDeadlineError(tried, lastHop);
      }

      const candidate = candidates[i];
      const { connector: connectorName, model, tier } = candidate;

      // Budget check for paid tier before any outbound call
      if (tier === 'paid') {
        const limitUsd = this.getBudgetLimitUsd();
        if (this.dailyPaidCostUsd >= limitUsd) {
          this.logger.warn(
            `Cascade budget exceeded: $${this.dailyPaidCostUsd.toFixed(4)} >= $${limitUsd}`,
          );
          // Record cascade metrics for the budget exceeded case
          this.metricsService.recordCascade({
            connector: connectorName,
            model,
            tier,
            status: 'budget_exceeded',
            fallbackCount,
            latencyMs: Date.now() - startMs,
            costUsd: 0,
            freeTierHit,
          });
          throw new CascadeBudgetExceededError(this.dailyPaidCostUsd, limitUsd);
        }
      }

      // Track free tier usage
      if (tier === 'free') {
        freeTierHit = true;
      }

      const transport = this.hopTransport(connectorName);
      const connectorRequest: ConnectorRequest = {
        ...request,
        model,
        timeout: capHopTimeout(
          configuredHopTimeoutMs(connectorName, request.timeout, transport.maxTimeout),
          remaining,
        ),
      };

      let response: ConnectorResponse;
      try {
        response = await this.connectorsService.execute(connectorName, connectorRequest, apiKeyId);
      } catch (err) {
        // ConnectorsService may throw NotFoundException for unknown connector
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Cascade: connector "${connectorName}" threw: ${errorMessage}`);
        tried.push({ connector: connectorName, model, errorType: 'connector_not_found' });
        lastHop = {
          connector: connectorName,
          model,
          errorType: 'connector_not_found',
          message: 'Connector unavailable',
        };
        fallbackCount++;
        continue;
      }

      if (response.status === 'success') {
        const latencyMs = Date.now() - startMs;
        const costUsd = response.usage.costUsd;

        // Track paid cost
        if (tier === 'paid') {
          this.dailyPaidCostUsd += costUsd;
        }

        this.metricsService.recordCascade({
          connector: connectorName,
          model,
          tier,
          status: 'success',
          fallbackCount,
          latencyMs,
          costUsd,
          freeTierHit,
        });

        return response;
      }

      // Classify the error to decide whether to advance or abort.
      // `timeout` advances only here, and only for an API hop that has not
      // already delivered a chunk. classifyErrorAction('timeout') stays abort
      // for direct callers.
      const errorType =
        response.error?.type ?? (response.status === 'timeout' ? 'timeout' : 'unknown');
      const message = response.error?.message ?? `Upstream ${errorType}`;

      tried.push({ connector: connectorName, model, errorType });
      lastHop = { connector: connectorName, model, errorType, message };

      const cascadeRetryable = chainShouldAdvance(errorType, {
        chunkSent: responseDeliveredChunk(response),
        allowTimeoutAdvance: transport.type === 'api',
      });

      if (!cascadeRetryable) {
        // Abort-class error — stop the cascade immediately
        this.logger.warn(`Cascade: abort-class error "${errorType}" on ${connectorName}:${model}`);
        this.metricsService.recordCascade({
          connector: connectorName,
          model,
          tier,
          status: 'abort',
          fallbackCount,
          latencyMs: Date.now() - startMs,
          costUsd: 0,
          freeTierHit,
        });
        throw new CascadeExhaustedError(tried);
      }

      // Retryable error (rate_limited, server_error, circuit_open, etc.) — advance
      this.logger.log(
        `Cascade: "${errorType}" on ${connectorName}:${model} — advancing to next candidate`,
      );
      fallbackCount++;
    }

    // All candidates exhausted
    this.metricsService.recordCascade({
      connector: 'none',
      model: 'none',
      tier: 'free',
      status: 'exhausted',
      fallbackCount,
      latencyMs: Date.now() - startMs,
      costUsd: 0,
      freeTierHit,
    });
    throw new CascadeExhaustedError(tried);
  }
}
