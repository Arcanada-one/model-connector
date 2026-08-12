// CONN-1665 — per-key access policy enforcement at the CONN-0244 single choke
// point (ConnectorsService.execute), plus the provider-key override (ALS) and
// the precedence matrix vs the global PROVIDER_ACCESS gate.
//
// House pattern: real ConnectorsService wired with FakeConnector (see
// openai-compat.failover.integration.spec.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConnectorsService } from './connectors.service';
import { PolicyService } from '../policy/policy.service';
import { getProviderKeyOverride, providerKeyContext } from '../policy/provider-key.context';
import { PrismaService } from '../prisma/prisma.service';
import {
  IConnector,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorCapabilities,
  ConnectorStatus,
} from './interfaces/connector.interface';
import type { ApiKeyPolicy } from '../policy/policy.schema';
import { FailoverRouterService } from './failover/failover-router.service';
import { FailoverAbortError } from './failover/failover.errors';

class FakeConnector implements IConnector {
  public calls = 0;
  public seenOverrides: Array<string | null> = [];
  constructor(
    public readonly name: string,
    private readonly model: string,
    private readonly behaviour: (req: ConnectorRequest) => ConnectorResponse,
    private readonly free = true,
  ) {}
  readonly type = 'api' as const;
  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    this.calls++;
    // Record what a retrofitted connector would read from the ALS context.
    this.seenOverrides.push(getProviderKeyOverride(this.name));
    return this.behaviour(request);
  }
  async getStatus(): Promise<ConnectorStatus> {
    return { name: this.name, healthy: true, activeJobs: 0, queuedJobs: 0, rateLimitStatus: 'ok' };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: [this.model],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 120_000,
      freeModels: this.free ? [this.model] : [],
      modelMeta: [{ id: this.model, free: this.free, modality: 'chat' }],
    };
  }
  resetCircuitBreaker() {
    return [];
  }
}

function ok(connector: string, model: string): ConnectorResponse {
  return {
    id: 'fake',
    connector,
    model,
    result: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
    latencyMs: 1,
    status: 'success',
  };
}

interface StackOptions {
  /** policy stored on the api key row (null = legacy unrestricted). */
  policy?: ApiKeyPolicy | null;
  /** (connector → model → tier) rows the fake catalog serves. */
  tiers?: Record<string, Record<string, 'free' | 'paid' | 'unknown'>>;
}

const API_KEY_ID = 'policy-key-1';

function buildStack(connectors: FakeConnector[], opts: StackOptions = {}) {
  const prisma = {
    request: { create: () => Promise.resolve({}) },
    apiKey: {
      findUnique: async () => ({ policy: opts.policy ?? null }),
    },
    modelCatalog: {
      findUnique: async ({
        where,
      }: {
        where: { connector_model: { connector: string; model: string } };
      }) => {
        const tier = opts.tiers?.[where.connector_model.connector]?.[where.connector_model.model];
        return tier ? { tier, absent: false } : null;
      },
    },
  };
  const jobQueue = {} as never;
  const metrics = { record: () => undefined } as never;
  const outputGuard = { wrapExecute: () => Promise.resolve({ response: null }) } as never;
  const policyService = new PolicyService(prisma as unknown as PrismaService);

  const service = new ConnectorsService(
    jobQueue,
    prisma as never,
    metrics,
    outputGuard,
    undefined,
    undefined,
    undefined,
    undefined,
    policyService,
  );
  for (const c of connectors) service.register(c);
  return { service, policyService };
}

describe('ConnectorsService per-key policy choke point (CONN-1665)', () => {
  const envBackup: Record<string, string | undefined> = {};
  const touchedEnv = ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_EMAIL_AGENT', 'PROVIDER_ACCESS'];

  beforeEach(() => {
    for (const k of touchedEnv) envBackup[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of touchedEnv) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });

  it('MUTATION TARGET: free-only policy + paid model → policy_violation, connector NEVER called', async () => {
    const openrouter = new FakeConnector('openrouter', 'paid-model', () =>
      ok('openrouter', 'paid-model'),
    );
    const { service } = buildStack([openrouter], {
      policy: { policyVersion: 1, providers: ['openrouter'], models: { mode: 'free-only' } },
      tiers: { openrouter: { 'paid-model': 'paid' } },
    });

    const resp = await service.execute(
      'openrouter',
      { prompt: 'hi', model: 'paid-model' },
      API_KEY_ID,
    );

    expect(resp.status).toBe('error');
    expect(resp.error?.type).toBe('policy_violation');
    expect(resp.error?.message).toContain('paid-model');
    expect(openrouter.calls).toBe(0);
  });

  it('free-only policy + catalog-free model → allowed', async () => {
    const openrouter = new FakeConnector('openrouter', 'free-model', () =>
      ok('openrouter', 'free-model'),
    );
    const { service } = buildStack([openrouter], {
      policy: { policyVersion: 1, models: { mode: 'free-only' } },
      tiers: { openrouter: { 'free-model': 'free' } },
    });

    const resp = await service.execute(
      'openrouter',
      { prompt: 'hi', model: 'free-model' },
      API_KEY_ID,
    );
    expect(resp.status).toBe('success');
    expect(openrouter.calls).toBe(1);
  });

  it('free-only + model UNKNOWN to the catalog → deny (fail-closed), distinct message', async () => {
    const openrouter = new FakeConnector('openrouter', 'mystery:free', () =>
      ok('openrouter', 'mystery:free'),
    );
    const { service } = buildStack([openrouter], {
      policy: { policyVersion: 1, models: { mode: 'free-only' } },
      tiers: {},
    });

    // NOTE the ':free' suffix — the id suffix must NOT be trusted (CONN-0244 false-free bug).
    const resp = await service.execute(
      'openrouter',
      { prompt: 'hi', model: 'mystery:free' },
      API_KEY_ID,
    );
    expect(resp.error?.type).toBe('policy_violation');
    expect(resp.error?.message).toContain('not recorded as free-tier in the model catalog');
    expect(openrouter.calls).toBe(0);
  });

  it('provider not in policy.providers → policy_violation naming the provider', async () => {
    const groq = new FakeConnector('groq', 'llama', () => ok('groq', 'llama'));
    const { service } = buildStack([groq], {
      policy: { policyVersion: 1, providers: ['openrouter'] },
    });

    const resp = await service.execute('groq', { prompt: 'hi', model: 'llama' }, API_KEY_ID);
    expect(resp.error?.type).toBe('policy_violation');
    expect(resp.error?.message).toContain('groq');
    expect(groq.calls).toBe(0);
  });

  it('model restriction present but request carries no model id → deny (fail-closed)', async () => {
    const openrouter = new FakeConnector('openrouter', 'free-model', () =>
      ok('openrouter', 'free-model'),
    );
    const { service } = buildStack([openrouter], {
      policy: { policyVersion: 1, models: { mode: 'free-only' } },
      tiers: { openrouter: { 'free-model': 'free' } },
    });

    const resp = await service.execute('openrouter', { prompt: 'hi' }, API_KEY_ID);
    expect(resp.error?.type).toBe('policy_violation');
    expect(openrouter.calls).toBe(0);
  });

  it('null policy (legacy key) → unrestricted', async () => {
    const groq = new FakeConnector('groq', 'llama', () => ok('groq', 'llama'));
    const { service } = buildStack([groq], { policy: null });
    const resp = await service.execute('groq', { prompt: 'hi', model: 'llama' }, API_KEY_ID);
    expect(resp.status).toBe('success');
  });

  describe('precedence matrix: per-key policy AND global PROVIDER_ACCESS', () => {
    it('global deny (use=false) + policy allow → deny (provider_not_routable)', async () => {
      process.env.PROVIDER_ACCESS = 'openrouter:read';
      const openrouter = new FakeConnector('openrouter', 'free-model', () =>
        ok('openrouter', 'free-model'),
      );
      const { service } = buildStack([openrouter], {
        policy: { policyVersion: 1, providers: ['openrouter'], models: { mode: 'all' } },
      });

      const resp = await service.execute(
        'openrouter',
        { prompt: 'hi', model: 'free-model' },
        API_KEY_ID,
      );
      expect(resp.error?.type).toBe('provider_not_routable');
      expect(openrouter.calls).toBe(0);
    });

    it('global allow (use=true) + policy deny → deny (policy_violation)', async () => {
      process.env.PROVIDER_ACCESS = 'openrouter:use';
      const openrouter = new FakeConnector('openrouter', 'free-model', () =>
        ok('openrouter', 'free-model'),
      );
      const { service } = buildStack([openrouter], {
        policy: { policyVersion: 1, providers: ['groq'] },
      });

      const resp = await service.execute(
        'openrouter',
        { prompt: 'hi', model: 'free-model' },
        API_KEY_ID,
      );
      expect(resp.error?.type).toBe('policy_violation');
      expect(openrouter.calls).toBe(0);
    });
  });

  describe('provider-key override (ALS across the whole retry loop)', () => {
    it('policy providerKeys.openrouter → connector sees the override on EVERY attempt', async () => {
      process.env.OPENROUTER_API_KEY = 'shared-key-value';
      process.env.OPENROUTER_API_KEY_EMAIL_AGENT = 'dedicated-key-value';

      let attempt = 0;
      const openrouter = new FakeConnector('openrouter', 'free-model', () => {
        attempt++;
        if (attempt === 1) {
          return {
            id: 'fake',
            connector: 'openrouter',
            model: 'free-model',
            result: '',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
            latencyMs: 1,
            status: 'error',
            error: {
              type: 'server_error',
              message: '500',
              retryable: true,
              recommendation: 'retry',
            },
          };
        }
        return ok('openrouter', 'free-model');
      });
      const { service } = buildStack([openrouter], {
        policy: {
          policyVersion: 1,
          providers: ['openrouter'],
          providerKeys: { openrouter: 'OPENROUTER_API_KEY_EMAIL_AGENT' },
        },
      });

      const resp = await service.execute(
        'openrouter',
        { prompt: 'hi', model: 'free-model', maxRetries: 1 },
        API_KEY_ID,
      );

      expect(resp.status).toBe('success');
      expect(openrouter.calls).toBe(2);
      // Both retry-loop attempts ran inside the ALS context with the DEDICATED key.
      expect(openrouter.seenOverrides).toEqual(['dedicated-key-value', 'dedicated-key-value']);
    });

    it('missing/empty env for the named alias → config_error, connector NOT called (no shared-key fallback)', async () => {
      process.env.OPENROUTER_API_KEY = 'shared-key-value';
      delete process.env.OPENROUTER_API_KEY_EMAIL_AGENT;

      const openrouter = new FakeConnector('openrouter', 'free-model', () =>
        ok('openrouter', 'free-model'),
      );
      const { service } = buildStack([openrouter], {
        policy: {
          policyVersion: 1,
          providerKeys: { openrouter: 'OPENROUTER_API_KEY_EMAIL_AGENT' },
        },
      });

      const resp = await service.execute(
        'openrouter',
        { prompt: 'hi', model: 'free-model' },
        API_KEY_ID,
      );

      expect(resp.error?.type).toBe('config_error');
      // Fail LOUD, no silent fallback to the shared env key: the request never ran.
      expect(openrouter.calls).toBe(0);
      // The client-facing message must NOT leak the env var name.
      expect(resp.error?.message).not.toContain('OPENROUTER_API_KEY_EMAIL_AGENT');
      expect(resp.error?.message).not.toContain('OPENROUTER_API_KEY');
    });

    it('no ALS context leaks outside execute()', async () => {
      const openrouter = new FakeConnector('openrouter', 'free-model', () =>
        ok('openrouter', 'free-model'),
      );
      process.env.OPENROUTER_API_KEY_EMAIL_AGENT = 'dedicated-key-value';
      const { service } = buildStack([openrouter], {
        policy: {
          policyVersion: 1,
          providerKeys: { openrouter: 'OPENROUTER_API_KEY_EMAIL_AGENT' },
        },
      });
      await service.execute('openrouter', { prompt: 'hi', model: 'free-model' }, API_KEY_ID);
      expect(providerKeyContext.getStore()).toBeUndefined();
    });
  });

  describe('error shapes (no env var names, provider named)', () => {
    it('policy_violation messages name the provider, never env var names', async () => {
      const groq = new FakeConnector('groq', 'llama', () => ok('groq', 'llama'));
      const { service } = buildStack([groq], {
        policy: {
          policyVersion: 1,
          providers: ['openrouter'],
          providerKeys: { openrouter: 'OPENROUTER_API_KEY_EMAIL_AGENT' },
        },
      });
      const resp = await service.execute('groq', { prompt: 'hi', model: 'llama' }, API_KEY_ID);
      expect(resp.error?.message).toContain('groq');
      expect(resp.error?.message).not.toMatch(/[A-Z][A-Z0-9]*(_[A-Z0-9]+){2,}/);
    });

    it('malformed STORED policy → config_error (fail-closed), no schema details leaked', async () => {
      const groq = new FakeConnector('groq', 'llama', () => ok('groq', 'llama'));
      const { service } = buildStack([groq], {
        policy: { policyVersion: 99 } as unknown as ApiKeyPolicy,
      });
      const resp = await service.execute('groq', { prompt: 'hi', model: 'llama' }, API_KEY_ID);
      expect(resp.error?.type).toBe('config_error');
      expect(groq.calls).toBe(0);
    });
  });

  describe('failover candidate filtering (attribution before dispatch)', () => {
    it('policy filters candidates; fully-emptied list → explicit policy_violation abort', async () => {
      const openrouter = new FakeConnector('openrouter', 'or-free', () =>
        ok('openrouter', 'or-free'),
      );
      const groq = new FakeConnector('groq', 'llama', () => ok('groq', 'llama'));
      const { service } = buildStack([openrouter, groq], {
        policy: { policyVersion: 1, providers: ['cohere'] },
      });
      const failover = new FailoverRouterService(service);

      await expect(
        failover.complete({ prompt: 'hi' }, API_KEY_ID, { requestedModel: 'auto' }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof FailoverAbortError && err.errorType === 'policy_violation',
      );
      expect(openrouter.calls).toBe(0);
      expect(groq.calls).toBe(0);
    });

    it('policy narrows the chain to allowed providers only', async () => {
      const openrouter = new FakeConnector('openrouter', 'or-free', () =>
        ok('openrouter', 'or-free'),
      );
      const groq = new FakeConnector('groq', 'llama', () => ok('groq', 'llama'));
      const { service } = buildStack([openrouter, groq], {
        policy: { policyVersion: 1, providers: ['groq'] },
      });
      const failover = new FailoverRouterService(service);

      const resp = await failover.complete({ prompt: 'hi' }, API_KEY_ID, {
        requestedModel: 'auto',
      });
      expect(resp.connector).toBe('groq');
      expect(openrouter.calls).toBe(0);
    });
  });
});
