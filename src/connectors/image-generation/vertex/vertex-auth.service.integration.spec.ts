/**
 * Integration test: VertexAuthService — real SA JWT → real Google access token.
 * Gate: RUN_INTEGRATION=1
 * Cost: 0 USD (token endpoint only, no AI calls)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { VertexAuthService } from './vertex-auth.service';

const shouldRun = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!shouldRun)('VertexAuthService [INTEGRATION]', () => {
  let service: VertexAuthService;

  beforeAll(() => {
    const saJson = process.env.VERTEX_SERVICE_ACCOUNT_JSON;
    const projectId = process.env.VERTEX_PROJECT_ID ?? 'arcanada-platform';
    const location = process.env.VERTEX_LOCATION ?? 'us-central1';

    if (!saJson) throw new Error('VERTEX_SERVICE_ACCOUNT_JSON not set — load .env.integration');

    service = new VertexAuthService(projectId, location, saJson);
  });

  it('fetches real access token from Google OAuth2', async () => {
    const t0 = Date.now();
    const token = await service.getAccessToken();
    const elapsed = Date.now() - t0;

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(50);
    // Google access tokens start with 'ya29.' (OAuth 2.0 bearer)
    expect(token).toMatch(/^ya29\./);

    console.log('[INT] Token obtained in', elapsed, 'ms, length:', token.length);
    console.log('[INT] Token prefix:', token.slice(0, 20) + '...');
  });

  it('caches token — second call returns same token without network round-trip', async () => {
    // Warm the cache
    const token1 = await service.getAccessToken();

    const t0 = Date.now();
    const token2 = await service.getAccessToken();
    const elapsed = Date.now() - t0;

    expect(token1).toBe(token2);
    // Cached path should be <2ms (no network)
    expect(elapsed).toBeLessThan(50);
    expect(service.isTokenReady).toBe(true);

    console.log('[INT] Cache hit elapsed:', elapsed, 'ms (should be <50ms)');
  });
});
