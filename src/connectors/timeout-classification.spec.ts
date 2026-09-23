import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { BaseApiConnector, ParsedApiOutput } from './base-api.connector';
import { BaseCliConnector, ParsedCliOutput } from './base-cli.connector';
import { ConnectorCapabilities, ConnectorRequest } from './interfaces/connector.interface';
import { validateEnv } from '../config/env.schema';

/**
 * A2-210 — a provider timeout was reported as a network error.
 *
 * `base-api.connector.ts` counted a failure as a timeout only for a
 * `DOMException` named `AbortError`. `AbortSignal.timeout()` — the only thing
 * that aborts an outbound connector request — aborts with name `TimeoutError`.
 * So the branch was unreachable: every provider timeout surfaced as
 * `network_error`, with `status: 'error'`, carrying the message
 * "The operation was aborted due to timeout" inside a network-error envelope.
 * That cost A2-205 and A2-206 two investigation cards.
 *
 * A2-207 (#139) added a rule on top of that dead branch: a caller whose OWN,
 * shorter budget expired must not feed the shared per-model breaker. It keys on
 * `errorType === 'timeout'`, so for API connectors it never fired either.
 *
 * The CLI lane had the same defect by a different mechanism: `spawn()`'s
 * `timeout` option kills the child and emits `close`, never `error` with
 * `ETIMEDOUT`, so `spawnProcess` RESOLVED on a timeout and the catch block —
 * including #139's rule — was never entered at all.
 *
 * Everything below runs against a local, non-answering HTTP server and a local
 * `sleep`. No production service is contacted.
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
  // A low threshold keeps the breaker tests to a handful of real timeouts.
  CIRCUIT_BREAKER_THRESHOLD: '3',
};

/** How long a probe is allowed to hang before we call it timed out. */
const SHORT_MS = 150;

// ---------------------------------------------------------------------------
// A server that accepts the connection and never answers. This is the whole
// point: the failure has to be produced by a real `AbortSignal.timeout()`
// firing on a real `fetch`, not by a hand-built DOMException. A test that
// constructs `new DOMException(msg, 'AbortError')` asserts what we wish Node
// did; this asserts what Node does.
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(() => {
    /* accept, then never respond */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

class HangingApiConnector extends BaseApiConnector {
  readonly name = 'timeout-probe';
  private readonly url: string;
  private readonly declaredMaxTimeout: number;
  private readonly connectorBudgetMs: number;

  constructor(url: string, declaredMaxTimeout = 600_000, connectorBudgetMs?: number) {
    super();
    this.url = url;
    this.declaredMaxTimeout = declaredMaxTimeout;
    this.connectorBudgetMs = connectorBudgetMs ?? 300_000;
  }

  // The connector's OWN budget, set directly rather than through a
  // `{NAME}_TIMEOUT_MS` env key: a probe connector has no declared key, and
  // inventing one would be an undeclared config read. How the figure is
  // resolved from configuration is A2-207's subject and is covered in
  // connector-budget-and-retry-after.spec.ts; what matters here is what
  // happens when it expires.
  protected getTimeout(): number {
    return this.connectorBudgetMs;
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
      maxTimeout: this.declaredMaxTimeout,
    };
  }
}

class SleepingCliConnector extends BaseCliConnector {
  readonly name = 'timeout-probe-cli';
  private readonly declaredMaxTimeout: number;
  private readonly connectorBudgetMs: number;
  /** The per-attempt budget the spawn was actually handed. */
  lastTimeoutSeen = -1;

  constructor(declaredMaxTimeout = 600_000, connectorBudgetMs?: number) {
    super();
    this.declaredMaxTimeout = declaredMaxTimeout;
    this.connectorBudgetMs = connectorBudgetMs ?? 300_000;
  }

  /** See HangingApiConnector.getTimeout(). */
  protected getTimeout(): number {
    return this.connectorBudgetMs;
  }

  protected getBinaryPath(): string {
    return '/bin/sleep';
  }
  protected buildArgs(): string[] {
    return ['30'];
  }
  protected parseOutput(stdout: string): ParsedCliOutput {
    return {
      text: stdout.trim(),
      model: 'probe-model',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'cli',
      models: ['probe-model'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: this.declaredMaxTimeout,
    };
  }

  protected spawnProcess(
    binary: string,
    args: string[],
    timeout: number,
    env: Record<string, string>,
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.lastTimeoutSeen = timeout;
    return super.spawnProcess(binary, args, timeout, env, cwd);
  }
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...OLD_ENV };
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('A2-210 §0 — what Node actually throws when a request runs out of time', () => {
  it('AbortSignal.timeout aborts with TimeoutError, never AbortError', async () => {
    let thrown: unknown;
    try {
      await fetch(`${baseUrl}/hang`, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(SHORT_MS),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('TimeoutError');
    expect((thrown as DOMException).message).toBe('The operation was aborted due to timeout');

    // Verbatim, the predicate `base-api.connector.ts` used to ask. It is false
    // for every timeout this service can produce.
    const predicateOnMain =
      thrown instanceof DOMException && (thrown as DOMException).name === 'AbortError';
    expect(predicateOnMain).toBe(false);
  });
});

describe('A2-210 §1 — an API connector names a timeout a timeout', () => {
  it('reports type `timeout` and status `timeout`, not `network_error`', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new HangingApiConnector(baseUrl);

    const res = await connector.execute({
      prompt: 'hi',
      model: 'probe-model',
      timeout: SHORT_MS,
    });

    expect(res.error?.type).toBe('timeout');
    expect(res.status).toBe('timeout');
    expect(res.error?.message).toBe('The operation was aborted due to timeout');
  });

  it("the connector's OWN expired budget is a timeout too", async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    // The request names no timeout of its own; the connector's budget is what runs out.
    const connector = new HangingApiConnector(baseUrl, 600_000, SHORT_MS);

    const res = await connector.execute({ prompt: 'hi', model: 'probe-model' });

    expect(res.error?.type).toBe('timeout');
    expect(res.status).toBe('timeout');
  });
});

describe('A2-210 §2 — #139’s caller-budget rule fires for API connectors', () => {
  it('a caller’s own shorter budget expiring does not open the shared breaker', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new HangingApiConnector(baseUrl);

    // One more than CIRCUIT_BREAKER_THRESHOLD=3. On main these are classified
    // `network_error`, so the rule does not apply and the breaker opens at 3.
    for (let i = 0; i < 4; i++) {
      const res = await connector.execute({
        prompt: 'hi',
        model: 'probe-model',
        timeout: SHORT_MS,
      });
      expect(res.error?.type).toBe('timeout');
    }

    const next = await connector.execute({
      prompt: 'hi',
      model: 'probe-model',
      timeout: SHORT_MS,
    });
    expect(next.error?.type).not.toBe('circuit_open');
    expect(next.error?.type).toBe('timeout');
  });

  it('the connector’s own expired budget still opens the breaker', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new HangingApiConnector(baseUrl, 600_000, SHORT_MS);

    for (let i = 0; i < 3; i++) {
      const res = await connector.execute({ prompt: 'hi', model: 'probe-model' });
      expect(res.error?.type).toBe('timeout');
    }

    const blocked = await connector.execute({ prompt: 'hi', model: 'probe-model' });
    expect(blocked.error?.type).toBe('circuit_open');
  });
});

describe('A2-210 §3 — a CLI connector names a timeout a timeout', () => {
  it('reports type `timeout` and status `timeout`, not `execution_error`', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new SleepingCliConnector();

    const res = await connector.execute({
      prompt: 'hi',
      model: 'probe-model',
      timeout: SHORT_MS,
    });

    expect(res.error?.type).toBe('timeout');
    expect(res.status).toBe('timeout');
  });

  it('a caller’s own shorter budget expiring does not open the shared breaker', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new SleepingCliConnector();

    for (let i = 0; i < 4; i++) {
      const res = await connector.execute({
        prompt: 'hi',
        model: 'probe-model',
        timeout: SHORT_MS,
      });
      expect(res.error?.type).toBe('timeout');
    }

    const next = await connector.execute({
      prompt: 'hi',
      model: 'probe-model',
      timeout: SHORT_MS,
    });
    expect(next.error?.type).not.toBe('circuit_open');
    expect(next.error?.type).toBe('timeout');
  });

  it('the connector’s own expired budget still opens the breaker', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new SleepingCliConnector(600_000, SHORT_MS);

    for (let i = 0; i < 3; i++) {
      const res = await connector.execute({ prompt: 'hi', model: 'probe-model' });
      expect(res.error?.type).toBe('timeout');
    }

    const blocked = await connector.execute({ prompt: 'hi', model: 'probe-model' });
    expect(blocked.error?.type).toBe('circuit_open');
  });
});

describe('A2-210 §4 — getCapabilities().maxTimeout is the per-connector ceiling', () => {
  it('clamps a caller budget above what the connector advertises (API)', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new HangingApiConnector(baseUrl, SHORT_MS);

    // The DTO accepts up to 600 000; this connector advertises SHORT_MS. On
    // main the request waits the full caller figure, because nothing reads
    // maxTimeout: the probe would hang for ten minutes.
    const started = Date.now();
    const res = await connector.execute({
      prompt: 'hi',
      model: 'probe-model',
      timeout: 600_000,
    });
    const elapsed = Date.now() - started;

    expect(res.error?.type).toBe('timeout');
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  it('clamps a caller budget above what the connector advertises (CLI)', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new SleepingCliConnector(SHORT_MS);

    const res = await connector.execute({
      prompt: 'hi',
      model: 'probe-model',
      timeout: 600_000,
    });

    expect(connector.lastTimeoutSeen).toBe(SHORT_MS);
    expect(res.error?.type).toBe('timeout');
  }, 10_000);

  it('a caller budget below the ceiling is left alone', async () => {
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new SleepingCliConnector(600_000);

    await connector.execute({ prompt: 'hi', model: 'probe-model', timeout: SHORT_MS });

    expect(connector.lastTimeoutSeen).toBe(SHORT_MS);
  });

  it('the ceiling caps the connector’s own configured budget as well', async () => {
    // An operator who sets CONNECTOR_TIMEOUT_MS=300000 on a connector that
    // advertises a 150 ms ceiling is asking for something the connector says it
    // cannot do. The advertised ceiling wins, and the advertisement stops being
    // decoration.
    validateEnv({ ...BASE_ENV, CONNECTOR_TIMEOUT_MS: '300000' });
    const connector = new SleepingCliConnector(SHORT_MS);

    await connector.execute({ prompt: 'hi', model: 'probe-model' });

    expect(connector.lastTimeoutSeen).toBe(SHORT_MS);
  }, 10_000);
});
