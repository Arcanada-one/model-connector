import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeRecovery } from '../src/recovery-policy.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe('force-fail recovery integration', () => {
  it('uses only the scoped reset endpoint and re-observes', async () => {
    const requests: string[] = [];
    let reset = false;
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === '/internal/watcher/circuit-breaker/reset') reset = true;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/health/connectors' ? { status: reset ? 'ok' : 'degraded' } : { reset: [], count: 0 }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture address');
    const forbidden = vi.fn();
    const result = await executeRecovery({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'x'.repeat(32),
      connector: 'openrouter',
      model: 'm',
      postProbeDelayMs: 0,
      forbidden,
    });
    expect(result.recovered).toBe(true);
    expect(requests).toEqual([
      'POST /internal/watcher/circuit-breaker/reset',
      'GET /health/connectors',
    ]);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
