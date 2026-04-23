import { describe, it, expect } from 'vitest';
import { BaseCliConnector, ParsedCliOutput, SpawnResult } from './base-cli.connector';
import { ConnectorCapabilities, ConnectorRequest } from './interfaces/connector.interface';

class TestConnector extends BaseCliConnector {
  name = 'test';

  protected getBinaryPath() {
    return '/usr/bin/echo';
  }

  protected buildArgs(request: ConnectorRequest): string[] {
    return [request.prompt];
  }

  protected parseOutput(stdout: string): ParsedCliOutput {
    return {
      text: stdout.trim(),
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.001,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'test',
      type: 'cli',
      models: ['test-model'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }

  // Expose for testing
  public testClassifyError(msg: string, code: number) {
    return this.classifyError(msg, code);
  }

  // Expose spawnProcess for mocking in concurrency tests
  public mockSpawnProcess(
    fn: (
      binary: string,
      args: string[],
      timeout: number,
      env: Record<string, string>,
      cwd?: string,
    ) => Promise<SpawnResult>,
  ) {
    this.spawnProcess = fn;
  }
}

describe('BaseCliConnector', () => {
  const connector = new TestConnector();

  it('should classify rate limit errors', () => {
    expect(connector.testClassifyError('rate limit exceeded', 1)).toBe('rate_limited');
    expect(connector.testClassifyError('server overloaded', 1)).toBe('rate_limited');
    expect(connector.testClassifyError('HTTP 429', 1)).toBe('rate_limited');
  });

  it('should classify auth errors', () => {
    expect(connector.testClassifyError('Not logged in', 1)).toBe('auth_error');
    expect(connector.testClassifyError('unauthorized', 1)).toBe('auth_error');
  });

  it('should classify binary not found (exit 127)', () => {
    expect(connector.testClassifyError('', 127)).toBe('binary_not_found');
  });

  it('should hash prompts with SHA-256', () => {
    const hash = BaseCliConnector.hashPrompt('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toBe(BaseCliConnector.hashPrompt('hello'));
    expect(hash).not.toBe(BaseCliConnector.hashPrompt('world'));
  });

  describe('exit code handling', () => {
    it('should treat response as success when parseOutput succeeds despite non-zero exitCode', async () => {
      const c = new TestConnector();
      c.setSemaphore(1);
      c.mockSpawnProcess(async () => ({
        stdout: 'valid response text',
        stderr: 'success',
        exitCode: 1,
      }));

      const result = await c.execute({ prompt: 'test' });
      expect(result.status).toBe('success');
      expect(result.result).toBe('valid response text');
      expect(result.error).toBeUndefined();
    });

    it('should treat as error when parseOutput returns empty text and exitCode is non-zero', async () => {
      const c = new TestConnector();
      c.setSemaphore(1);
      // Override parseOutput to return empty text (simulating parse failure)
      c.mockSpawnProcess(async () => ({
        stdout: '',
        stderr: 'binary not found',
        exitCode: 127,
      }));
      // TestConnector.parseOutput returns stdout.trim() as text — empty stdout → empty text
      // BUT it also returns isError: false. With the fix, empty text + non-zero exit → error.
      const result = await c.execute({ prompt: 'test' });
      expect(result.status).toBe('error');
      expect(result.error?.type).toBe('binary_not_found');
    });
  });

  describe('per-model circuit breaker', () => {
    it('should isolate circuit breaker per model — model A open does not block model B', async () => {
      const c = new TestConnector();
      c.setSemaphore(1);
      let callCount = 0;
      c.mockSpawnProcess(async () => {
        callCount++;
        if (callCount <= 5) {
          // First 5 calls fail (model-a) — threshold is 5 by default
          return { stdout: '', stderr: 'rate limit exceeded', exitCode: 1 };
        }
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      });

      // Trip circuit breaker for model-a (5 failures = threshold)
      for (let i = 0; i < 5; i++) {
        await c.execute({ prompt: 'test', model: 'model-a' });
      }

      // model-a should be blocked
      const blockedResult = await c.execute({ prompt: 'test', model: 'model-a' });
      expect(blockedResult.status).toBe('error');
      expect(blockedResult.error?.type).toBe('circuit_open');

      // model-b should still work
      const okResult = await c.execute({ prompt: 'test', model: 'model-b' });
      expect(okResult.status).toBe('success');
      expect(okResult.result).toBe('ok');
    });

    it('should return per-model circuit breaker states in getStatus', async () => {
      const c = new TestConnector();
      c.setSemaphore(1);
      c.mockSpawnProcess(async () => ({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
      }));

      // Make requests with different models to create CB entries
      await c.execute({ prompt: 'test', model: 'model-x' });
      await c.execute({ prompt: 'test', model: 'model-y' });

      const status = await c.getStatus();
      expect(status.circuitBreakers).toBeDefined();
      expect(status.circuitBreakers!['model-x']).toBeDefined();
      expect(status.circuitBreakers!['model-y']).toBeDefined();
      expect(status.circuitBreakers!['model-x'].state).toBe('closed');
      expect(status.circuitBreakers!['model-y'].state).toBe('closed');
    });

    it('should show aggregate as open when any model is open', async () => {
      const c = new TestConnector();
      c.setSemaphore(1);
      let callCount = 0;
      c.mockSpawnProcess(async () => {
        callCount++;
        if (callCount === 1) {
          // First call (model-a) fails with auth_error → instant open
          return { stdout: '', stderr: 'unauthorized', exitCode: 1 };
        }
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      });

      // Open circuit for model-a via auth_error (instant open)
      await c.execute({ prompt: 'test', model: 'model-a' });

      // model-b succeeds
      await c.execute({ prompt: 'test', model: 'model-b' });

      const status = await c.getStatus();
      expect(status.circuitBreaker?.state).toBe('open');
      expect(status.circuitBreakers!['model-a'].state).toBe('open');
      expect(status.circuitBreakers!['model-b'].state).toBe('closed');
      // Connector is unhealthy because aggregate shows worst state
      expect(status.healthy).toBe(false);
    });

    it('should lazy-create circuit breaker per model', async () => {
      const c = new TestConnector();
      c.setSemaphore(1);
      c.mockSpawnProcess(async () => ({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
      }));

      // Initially no circuit breakers
      const statusBefore = await c.getStatus();
      expect(Object.keys(statusBefore.circuitBreakers ?? {})).toHaveLength(0);

      // After one request, one CB created
      await c.execute({ prompt: 'test', model: 'gpt-4' });
      const statusAfter = await c.getStatus();
      expect(Object.keys(statusAfter.circuitBreakers ?? {})).toHaveLength(1);
      expect(statusAfter.circuitBreakers!['gpt-4']).toBeDefined();
    });
  });

  describe('semaphore concurrency', () => {
    function makeDelayConnector(delayMs: number): TestConnector {
      const c = new TestConnector();
      c.mockSpawnProcess(async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      });
      return c;
    }

    const req: ConnectorRequest = { prompt: 'test', model: 'test-model' };

    it('should serialize concurrent calls when max=1', async () => {
      const c = makeDelayConnector(50);
      c.setSemaphore(1);

      const start = Date.now();
      const results = await Promise.all([c.execute(req), c.execute(req), c.execute(req)]);
      const elapsed = Date.now() - start;

      expect(results).toHaveLength(3);
      results.forEach((r) => expect(r.status).toBe('success'));
      // 3 serial calls × 50ms = ~150ms minimum
      expect(elapsed).toBeGreaterThanOrEqual(120);
    });

    it('should run in parallel when max=3', async () => {
      const c = makeDelayConnector(50);
      c.setSemaphore(3);

      const start = Date.now();
      const results = await Promise.all([c.execute(req), c.execute(req), c.execute(req)]);
      const elapsed = Date.now() - start;

      expect(results).toHaveLength(3);
      results.forEach((r) => expect(r.status).toBe('success'));
      // 3 parallel calls = ~50ms, well under 120ms
      expect(elapsed).toBeLessThan(120);
    });

    it('should release semaphore on spawn error', async () => {
      const c = new TestConnector();
      c.setSemaphore(1);
      let callCount = 0;
      c.mockSpawnProcess(async () => {
        callCount++;
        if (callCount === 1) throw new Error('spawn failure');
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      });

      const r1 = await c.execute(req);
      expect(r1.status).toBe('error');

      // Second call should proceed (semaphore was released despite error)
      const r2 = await c.execute(req);
      expect(r2.status).toBe('success');
    });

    it('should report queued jobs in getStatus()', async () => {
      const c = new TestConnector();
      c.setSemaphore(1);

      const resolvers: Array<() => void> = [];
      c.mockSpawnProcess(
        () =>
          new Promise((resolve) => {
            resolvers.push(() => resolve({ stdout: 'ok', stderr: '', exitCode: 0 }));
          }),
      );

      // Start first call — occupies the semaphore
      const p1 = c.execute(req);
      // Allow acquire + spawnProcess to be called
      await new Promise((r) => setTimeout(r, 10));

      // Start second call — will queue on semaphore
      const p2 = c.execute(req);
      await new Promise((r) => setTimeout(r, 10));

      const status = await c.getStatus();
      expect(status.activeJobs).toBe(1);
      expect(status.queuedJobs).toBe(1);

      // Resolve first call → releases semaphore → second starts
      resolvers[0]();
      await p1;
      await new Promise((r) => setTimeout(r, 10));

      // Resolve second call
      resolvers[1]();
      await p2;
    });
  });
});
