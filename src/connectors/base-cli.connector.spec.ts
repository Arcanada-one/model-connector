import { describe, it, expect, vi } from 'vitest';
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
    fn: (binary: string, args: string[], timeout: number, env: Record<string, string>, cwd?: string) => Promise<SpawnResult>,
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
      c.mockSpawnProcess(() => new Promise((resolve) => {
        resolvers.push(() => resolve({ stdout: 'ok', stderr: '', exitCode: 0 }));
      }));

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
