// CONN-0243 — OpenAI-compat failover integration test (DoD AC2 / AC3).
//
// Wires the REAL ConnectorsService.execute path + the REAL FailoverRouterService +
// the REAL OpenAiCompatController, with two fake IConnectors registered. Forces a
// 429 on the first (DeepSeek) provider and asserts that a DIFFERENT provider served
// the completion through the OpenAI-shaped surface — the durable Hermes fix.

import { describe, it, expect } from 'vitest';
import { ConnectorsService } from '../connectors/connectors.service';
import { FailoverRouterService } from '../connectors/failover/failover-router.service';
import { OpenAiCompatController } from './openai-compat.controller';
import {
  IConnector,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorCapabilities,
  ConnectorStatus,
} from '../connectors/interfaces/connector.interface';
import { OpenAiChatCompletionRequest } from './dto/openai-chat.dto';

// ── Fake connector ────────────────────────────────────────────────────────────
class FakeConnector implements IConnector {
  public calls = 0;
  constructor(
    public readonly name: string,
    private readonly model: string,
    private readonly behaviour: (req: ConnectorRequest) => ConnectorResponse,
  ) {}
  readonly type = 'api' as const;
  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    this.calls++;
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
      freeModels: [this.model],
      modelMeta: [{ id: this.model, free: true, modality: 'chat' }],
    };
  }
  resetCircuitBreaker() {
    return [];
  }
}

function ok(connector: string, model: string, text: string): ConnectorResponse {
  return {
    id: 'fake',
    connector,
    model,
    result: text,
    usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7, costUsd: 0 },
    latencyMs: 8,
    status: 'success',
  };
}

function rateLimited(connector: string, model: string): ConnectorResponse {
  return {
    id: 'fake',
    connector,
    model,
    result: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    latencyMs: 3,
    status: 'rate_limited',
    error: {
      type: 'rate_limited',
      message: '429 from provider',
      retryable: true,
      recommendation: 'wait',
    },
  };
}

function buildStack(connectors: FakeConnector[]) {
  // Minimal stubs for the deps ConnectorsService.execute actually touches:
  // metrics.record (no-op) and prisma.request.create (fire-and-forget, caught).
  const jobQueue = {} as never;
  const prisma = { request: { create: () => Promise.resolve({}) } } as never;
  const metrics = { record: () => undefined } as never;
  const outputGuard = { wrapExecute: () => Promise.resolve({ response: null }) } as never;

  const service = new ConnectorsService(jobQueue, prisma, metrics, outputGuard);
  for (const c of connectors) service.register(c);

  const failover = new FailoverRouterService(service);
  const controller = new OpenAiCompatController(failover, service);
  return { service, failover, controller };
}

const req = { apiKey: { id: 'itest-key' } } as never;

const body: OpenAiChatCompletionRequest = {
  model: 'auto',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Say hi.' },
  ],
} as OpenAiChatCompletionRequest;

describe('OpenAI-compat failover integration', () => {
  it('AC2: first provider 429 → a DIFFERENT provider serves the OpenAI completion', async () => {
    // openmodel (DeepSeek, free, first hop) returns 429; groq (free) succeeds.
    const deepseek = new FakeConnector('openmodel', 'deepseek-v4-flash', () =>
      rateLimited('openmodel', 'deepseek-v4-flash'),
    );
    const groq = new FakeConnector('groq', 'llama-3.3-70b-versatile', () =>
      ok('groq', 'llama-3.3-70b-versatile', 'hi'),
    );
    const { controller } = buildStack([deepseek, groq]);

    const out = await controller.chatCompletions(body, req);

    expect(out.object).toBe('chat.completion');
    expect(out.choices[0].message.content).toBe('hi');
    // The completion was served by groq, NOT the 429'd openmodel.
    expect(out.model).toBe('llama-3.3-70b-versatile');
    expect(deepseek.calls).toBe(1); // exactly one inner attempt (maxRetries:0, R-F1)
    expect(groq.calls).toBe(1);
  });

  it('AC3: free-first — DeepSeek (openmodel) is attempted before groq', async () => {
    const order: string[] = [];
    const deepseek = new FakeConnector('openmodel', 'deepseek-v4-flash', () => {
      order.push('openmodel');
      return ok('openmodel', 'deepseek-v4-flash', 'from-deepseek');
    });
    const groq = new FakeConnector('groq', 'llama-3.3-70b-versatile', () => {
      order.push('groq');
      return ok('groq', 'llama-3.3-70b-versatile', 'from-groq');
    });
    // Register groq FIRST to prove ordering is by free-first policy, not registration order.
    const { controller } = buildStack([groq, deepseek]);

    const out = await controller.chatCompletions(body, req);

    expect(order[0]).toBe('openmodel');
    expect(out.choices[0].message.content).toBe('from-deepseek');
  });

  it('all providers 429 → 503 (cascade_exhausted), no provider served', async () => {
    const deepseek = new FakeConnector('openmodel', 'deepseek-v4-flash', () =>
      rateLimited('openmodel', 'deepseek-v4-flash'),
    );
    const groq = new FakeConnector('groq', 'llama-3.3-70b-versatile', () =>
      rateLimited('groq', 'llama-3.3-70b-versatile'),
    );
    const { controller } = buildStack([deepseek, groq]);

    await expect(controller.chatCompletions(body, req)).rejects.toMatchObject({ status: 503 });
  });
});
