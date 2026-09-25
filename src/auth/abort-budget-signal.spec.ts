import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { of, firstValueFrom } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';

import { BaseApiConnector, ParsedApiOutput } from '../connectors/base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
} from '../connectors/interfaces/connector.interface';
import { AbortBudgetInterceptor } from './abort-budget.interceptor';
import { KeyRateLimitService } from './key-rate-limit.service';
import { validateEnv } from '../config/env.schema';

/**
 * A2-301 — the abort budget counts what the REAL connector really writes.
 *
 * The trap this file exists to avoid: `AbortBudgetInterceptor` keys on
 * `status === 'timeout'`, and a spec that feeds it a hand-written
 * `{ status: 'timeout' }` proves only that the author typed the same string
 * twice. A2-210 is the precedent — a predicate in this very file's subject
 * matter asked for `'AbortError'` for months while Node produced
 * `'TimeoutError'`, and every test around it agreed with the bug.
 *
 * So the value under test is produced here by a REAL `AbortSignal.timeout()`
 * firing on a REAL `fetch` against a local server that never answers, passing
 * through the REAL `BaseApiConnector.execute`. Whatever that returns is what the
 * interceptor is then handed. If `base-api.connector.ts` ever stops marking an
 * aborted attempt with `status: 'timeout'`, this fails — which is the whole
 * point, because the budget would silently stop being fed.
 *
 * No production service is contacted and no provider is paid: the server is
 * local and answers nothing.
 */

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn-abort-test:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
  CONNECTOR_TIMEOUT_MS: '300000',
};

/** How long the probe may hang before the deadline cuts it. */
const SHORT_MS = 150;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(() => {
    /* accept the connection, then never answer */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Same probe shape as timeout-classification.spec.ts, which owns this pattern. */
class HangingApiConnector extends BaseApiConnector {
  readonly name = 'abort-budget-probe';
  constructor(private readonly url: string) {
    super();
  }
  protected getTimeout(): number {
    return 300_000;
  }
  protected getBaseUrl(): string {
    return this.url;
  }
  protected buildRequestUrl(): string {
    return `${this.url}/v1/hang`;
  }
  protected buildRequestBody(request: ConnectorRequest): unknown {
    return { input: request.prompt };
  }
  protected parseResponse(): ParsedApiOutput {
    return {
      text: 'unreachable',
      model: 'probe',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: ['probe-model'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 600_000,
    };
  }
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...OLD_ENV };
  validateEnv(BASE_ENV);
});
afterEach(() => {
  process.env = { ...OLD_ENV };
});

function contextFor(keyId: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => (keyId ? { apiKey: { id: keyId } } : {}) }),
  } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe("the abort signal the budget counts is the connector's own", () => {
  it('a real aborted fetch yields the outcome the interceptor keys on', async () => {
    const connector = new HangingApiConnector(baseUrl);

    const real = await connector.execute({
      prompt: 'hi',
      model: 'probe-model',
      timeout: SHORT_MS,
    });

    // Produced by Node, not by this test.
    expect(real.status).toBe('timeout');

    const recordAbort = vi.fn(async () => undefined);
    const interceptor = new AbortBudgetInterceptor({
      recordAbort,
    } as unknown as KeyRateLimitService);

    // The REAL response object goes in — no literal is retyped here.
    const passedThrough = await firstValueFrom(
      interceptor.intercept(contextFor('key-a'), handlerReturning(real)),
    );

    expect(recordAbort).toHaveBeenCalledWith('key-a');
    // The caller's response is returned untouched: the budget observes, it does
    // not rewrite what the client receives.
    expect(passedThrough).toBe(real);
  });

  it('a real SUCCESS from the same connector is not counted', async () => {
    // A server that answers, through the same production code path.
    const answering = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => answering.listen(0, '127.0.0.1', resolve));
    const { port } = answering.address() as AddressInfo;

    try {
      const connector = new HangingApiConnector(`http://127.0.0.1:${port}`);
      const real = await connector.execute({
        prompt: 'hi',
        model: 'probe-model',
        timeout: 5_000,
      });

      expect(real.status).toBe('success');

      const recordAbort = vi.fn(async () => undefined);
      const interceptor = new AbortBudgetInterceptor({
        recordAbort,
      } as unknown as KeyRateLimitService);

      await firstValueFrom(interceptor.intercept(contextFor('key-a'), handlerReturning(real)));

      expect(recordAbort).not.toHaveBeenCalled();
    } finally {
      answering.closeAllConnections?.();
      await new Promise<void>((resolve) => answering.close(() => resolve()));
    }
  });

  it('an unauthenticated request cannot be charged to anyone', async () => {
    const recordAbort = vi.fn(async () => undefined);
    const interceptor = new AbortBudgetInterceptor({
      recordAbort,
    } as unknown as KeyRateLimitService);

    await firstValueFrom(
      interceptor.intercept(contextFor(undefined), handlerReturning({ status: 'timeout' })),
    );

    expect(recordAbort).not.toHaveBeenCalled();
  });
});
