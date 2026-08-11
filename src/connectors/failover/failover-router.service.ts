// CONN-0243 — cross-provider failover gateway router.
//
// Builds a free-first, DeepSeek-first candidate list from in-memory connector
// capabilities (no network probes — R-F3) and runs the pure failover chain,
// passing maxRetries:0 so the inner per-connector retry loop does not compound
// exponential backoff on every failover hop (R-F1). The chain owns retry/advance.
//
// NO fetch/http here — transport is delegated to ConnectorsService.execute.

import { Injectable, Logger } from '@nestjs/common';
import { ConnectorsService } from '../connectors.service';
import { ConnectorRequest, ConnectorResponse } from '../interfaces/connector.interface';
import { buildFailoverCandidates } from './failover.candidates';
import { runFailoverChain } from './failover.chain';
import { getConfig } from '../../config/env.schema';

export interface FailoverOptions {
  /** OpenAI `model` field — a preference, not a hard constraint (see candidate builder). */
  requestedModel?: string;
}

interface FailoverConfig {
  providerOrder: string[];
  deepseekModel: string;
  paidEnabled: boolean;
  allowFreeDowngrade: boolean;
}

@Injectable()
export class FailoverRouterService {
  private readonly logger = new Logger(FailoverRouterService.name);

  constructor(private readonly connectorsService: ConnectorsService) {}

  private readConfig(): FailoverConfig {
    let order = 'openmodel,groq,openrouter,gemini';
    let deepseekModel = 'deepseek-v4-flash';
    let paidEnabled = false;
    let allowFreeDowngrade = true;
    try {
      const c = getConfig();
      order = c.FAILOVER_PROVIDER_ORDER ?? order;
      deepseekModel = c.FAILOVER_DEEPSEEK_MODEL ?? deepseekModel;
      paidEnabled = c.FAILOVER_PAID_ENABLED ?? paidEnabled;
      allowFreeDowngrade = c.FAILOVER_ALLOW_FREE_DOWNGRADE ?? allowFreeDowngrade;
    } catch {
      // Test environments where env is not fully loaded — fall back to defaults.
      order = process.env.FAILOVER_PROVIDER_ORDER || order;
      deepseekModel = process.env.FAILOVER_DEEPSEEK_MODEL || deepseekModel;
    }
    return {
      providerOrder: order
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      deepseekModel,
      paidEnabled,
      allowFreeDowngrade,
    };
  }

  /**
   * Resolve an OpenAI-shaped chat request to a live completion via the free-first
   * failover chain. Throws FailoverExhaustedError when no candidate succeeds.
   */
  async complete(
    request: Omit<ConnectorRequest, 'connector'>,
    apiKeyId: string,
    opts: FailoverOptions = {},
  ): Promise<ConnectorResponse> {
    const cfg = this.readConfig();
    const candidates = buildFailoverCandidates({
      capabilities: this.connectorsService.listCapabilities(),
      requestedModel: opts.requestedModel,
      providerOrder: cfg.providerOrder,
      deepseekModel: cfg.deepseekModel,
      paidEnabled: cfg.paidEnabled,
      allowFreeDowngrade: cfg.allowFreeDowngrade,
    });

    this.logger.log(
      `Failover: ${candidates.length} candidate(s) for model="${opts.requestedModel ?? 'auto'}": ` +
        candidates.map((c) => `${c.connector}:${c.model}`).join(' → '),
    );

    // maxRetries:0 — the failover chain owns retry/advance; the inner loop makes one attempt.
    const chainRequest: Omit<ConnectorRequest, 'connector'> = { ...request, maxRetries: 0 };

    return runFailoverChain({
      candidates,
      execute: (connector, req, key) => this.connectorsService.execute(connector, req, key),
      request: chainRequest,
      apiKeyId,
      onAttempt: (candidate, _resp, outcome) => {
        if (outcome === 'advance') {
          this.logger.warn(
            `Failover: ${candidate.connector}:${candidate.model} failed — advancing`,
          );
        }
      },
    });
  }
}
