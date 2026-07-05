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
      return buildLowReasoningCandidates({
        lowReasoningOrder: config.CASCADE_LOW_REASONING_ORDER,
        paidEnabled: config.CASCADE_PAID_ENABLED,
      });
    }
    throw new Error(`Unknown cascade profile: "${profile}"`);
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
  ): Promise<ConnectorResponse> {
    this.resetDailyBudgetIfNeeded();

    const candidates = this.getCandidates(profile);
    const tried: { connector: string; model: string; errorType: string }[] = [];
    const startMs = Date.now();
    let fallbackCount = 0;
    let freeTierHit = false;

    for (let i = 0; i < candidates.length; i++) {
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

      const connectorRequest: ConnectorRequest = {
        ...request,
        model,
      };

      let response: ConnectorResponse;
      try {
        response = await this.connectorsService.execute(connectorName, connectorRequest, apiKeyId);
      } catch (err) {
        // ConnectorsService may throw NotFoundException for unknown connector
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Cascade: connector "${connectorName}" threw: ${errorMessage}`);
        tried.push({ connector: connectorName, model, errorType: 'connector_not_found' });
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

      // Classify the error to decide whether to advance or abort
      const errorType = response.error?.type ?? 'unknown';
      const action = classifyErrorAction(errorType);

      tried.push({ connector: connectorName, model, errorType });

      // circuit_open is retryable in cascade context: the circuit breaker is per-connector,
      // so opening on one connector is a signal to fallback to the next, not abort the cascade.
      const cascadeRetryable = action.retryable || errorType === 'circuit_open';

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
