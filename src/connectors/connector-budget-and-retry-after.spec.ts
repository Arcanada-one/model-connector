import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseApiConnector, ParsedApiOutput } from './base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from './interfaces/connector.interface';
import { validateEnv } from '../config/env.schema';

/**
 * A2-207 — three defects that all live on the attempt-budget path:
 *
 *  1. `CONNECTOR_TIMEOUT_MS` was declared, documented and set by operators, and
 *     read by nobody: every API connector without an override got a hard-coded
 *     30 000 ms.
 *  2. `retryAfter` on an open breaker is milliseconds, and two of our own
 *     clients read it as seconds.
 *  3. A caller whose OWN budget ran out fed the shared per-model breaker, so
 *     one impatient client could close a route for everyone.
 */

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
};

/** An API connector that overrides nothing about timeouts — the majority case. */
class BudgetConnector extends BaseApiConnector {
  readonly name = 'budget-test';

  protected getBaseUrl(): string {
    return 'http://localhost:9999';
  }
  protected buildRequestUrl(): string {
    return `${this.getBaseUrl()}/v1/test`;
  }
  protected buildRequestBody(request: ConnectorRequest): unknown {
    return { input: request.prompt };
  }
  protected parseResponse(json: unknown): ParsedApiOutput {
    const data = json as { result: string; tokens: number };
    return {
      text: data.result,
      model: 'budget-model',
      inputTokens: data.tokens,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: ['budget-model'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 600_000,
    };
  }
}

/** A connector with its own env knob, in the shape every real connector uses. */
class OverridingConnector extends BudgetConnector {
  readonly name = 'overriding-test';
  protected getTimeout(): number {
    return Number(process.env.OVERRIDING_TEST_TIMEOUT_MS) || super.getTimeout();
  }
}

const budgetOf = (c: BaseApiConnector): number =>
  (c as unknown as { getTimeout: () => number }).getTimeout();

const abortError = () =>
  new DOMException('The operation was aborted due to timeout', 'AbortError');

describe('A2-207 — the attempt budget, the retry-after unit and what feeds the breaker', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.restoreAllMocks();
  });

  describe('1 — CONNECTOR_TIMEOUT_MS governs the attempt budget', () => {
    it('an API connector with no override takes the operator figure', () => {
      validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
      expect(budgetOf(new BudgetConnector())).toBe(300_000);
    });

    it('defaults to 120 000 ms when the operator sets nothing', () => {
      validateEnv({ ...BASE_ENV });
      expect(budgetOf(new BudgetConnector())).toBe(120_000);
    });

    it('a per-connector env var still wins over the global figure', () => {
      validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
      process.env.OVERRIDING_TEST_TIMEOUT_MS = '45000';
      expect(budgetOf(new OverridingConnector())).toBe(45_000);
    });

    it('a connector with an env knob and no value set inherits the global figure', () => {
      validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
      delete process.env.OVERRIDING_TEST_TIMEOUT_MS;
      expect(budgetOf(new OverridingConnector())).toBe(300_000);
    });

    it('the configured budget is what actually reaches the outbound request', async () => {
      validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'ok', tokens: 1 }),
      });

      await new BudgetConnector().execute({ prompt: 'hi', model: 'budget-model' });

      expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    });
  });

  describe('2 — retryAfter is milliseconds and says so in seconds too', () => {
    it('an open breaker reports the cooldown in both units, consistently', async () => {
      validateEnv({ ...BASE_ENV });
      const connector = new BudgetConnector();

      // auth_error opens the breaker instantly (INSTANT_OPEN_ERRORS).
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized'),
      });
      await connector.execute({ prompt: 'hi', model: 'budget-model' });

      const blocked = await connector.execute({ prompt: 'hi', model: 'budget-model' });
      expect(blocked.error?.type).toBe('circuit_open');

      // CIRCUIT_BREAKER_COOLDOWN_MS defaults to 30 000. Milliseconds, not seconds:
      // a reader who took this for seconds would wait eight hours.
      expect(blocked.error?.retryAfter).toBeGreaterThan(25_000);
      expect(blocked.error?.retryAfter).toBeLessThanOrEqual(30_000);

      expect(blocked.error?.retryAfterSeconds).toBe(
        Math.ceil((blocked.error!.retryAfter as number) / 1000),
      );
      expect(blocked.error?.retryAfterSeconds).toBeLessThanOrEqual(30);
    });
  });

  describe('3 — the caller’s own budget is not evidence about the provider', () => {
    it('does not open the breaker when the caller’s shorter budget runs out', async () => {
      validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
      const connector = new BudgetConnector();
      fetchSpy.mockRejectedValue(abortError());

      // Six consecutive caller-budget timeouts — one more than the default
      // threshold of 5, i.e. exactly the 3 client attempts x 2 server attempts
      // that closed a live route for every other caller (A2-203).
      for (let i = 0; i < 6; i++) {
        const res = await connector.execute({
          prompt: 'hi',
          model: 'budget-model',
          timeout: 5_000,
        });
        expect(res.status).toBe('timeout');
        expect(res.error?.type).toBe('timeout');
      }

      const next = await connector.execute({
        prompt: 'hi',
        model: 'budget-model',
        timeout: 5_000,
      });
      expect(next.error?.type).toBe('timeout');
      expect(next.error?.type).not.toBe('circuit_open');
    });

    it('still opens the breaker when the connector’s OWN budget runs out', async () => {
      validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
      const connector = new BudgetConnector();
      fetchSpy.mockRejectedValue(abortError());

      for (let i = 0; i < 5; i++) {
        const res = await connector.execute({ prompt: 'hi', model: 'budget-model' });
        expect(res.error?.type).toBe('timeout');
      }

      const blocked = await connector.execute({ prompt: 'hi', model: 'budget-model' });
      expect(blocked.error?.type).toBe('circuit_open');
    });

    it('a caller budget at or above the connector budget still feeds the breaker', async () => {
      validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '30000' });
      const connector = new BudgetConnector();
      fetchSpy.mockRejectedValue(abortError());

      for (let i = 0; i < 5; i++) {
        const res = await connector.execute({
          prompt: 'hi',
          model: 'budget-model',
          timeout: 60_000,
        });
        expect(res.error?.type).toBe('timeout');
      }

      const blocked = await connector.execute({
        prompt: 'hi',
        model: 'budget-model',
        timeout: 60_000,
      });
      expect(blocked.error?.type).toBe('circuit_open');
    });

    it('a non-timeout failure under a short caller budget still feeds the breaker', async () => {
      validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
      const connector = new BudgetConnector();
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('upstream on fire'),
      });

      for (let i = 0; i < 5; i++) {
        const res = await connector.execute({
          prompt: 'hi',
          model: 'budget-model',
          timeout: 5_000,
        });
        expect(res.error?.type).toBe('server_error');
      }

      const blocked = await connector.execute({
        prompt: 'hi',
        model: 'budget-model',
        timeout: 5_000,
      });
      expect(blocked.error?.type).toBe('circuit_open');
    });
  });
});
