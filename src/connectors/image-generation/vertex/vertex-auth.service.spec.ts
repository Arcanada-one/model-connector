import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VertexAuthService } from './vertex-auth.service';

interface GoogleAuthMockInstance {
  getAccessToken: ReturnType<typeof vi.fn>;
}

// Stub google-auth-library before importing
vi.mock('google-auth-library', () => {
  const mockGetAccessToken = vi.fn().mockResolvedValue({ token: 'mock-access-token' });
  const MockGoogleAuth = vi.fn().mockImplementation(function (this: GoogleAuthMockInstance) {
    this.getAccessToken = mockGetAccessToken;
  });
  return { GoogleAuth: MockGoogleAuth };
});

describe('VertexAuthService', () => {
  let service: VertexAuthService;

  beforeEach(() => {
    service = new VertexAuthService(
      'test-project',
      'us-central1',
      JSON.stringify({ type: 'service_account', project_id: 'test' }),
    );
  });

  it('returns access token on first call', async () => {
    const token = await service.getAccessToken();
    expect(token).toBe('mock-access-token');
  });

  it('caches the token for subsequent calls within TTL', async () => {
    const { GoogleAuth } = await import('google-auth-library');
    // First call populates cache
    await service.getAccessToken();
    const instanceZero = vi.mocked(GoogleAuth).mock
      .instances[0] as unknown as GoogleAuthMockInstance;
    const callCountAfterFirst = instanceZero.getAccessToken.mock.calls.length;
    // Second call should not hit underlying auth (cached)
    await service.getAccessToken();
    const callCountAfterSecond = instanceZero.getAccessToken.mock.calls.length;
    expect(callCountAfterSecond).toBe(callCountAfterFirst);
  });

  it('refreshes token after TTL expiry', async () => {
    const { GoogleAuth } = await import('google-auth-library');
    // First call to prime the cache
    await service.getAccessToken();
    const instanceZero = vi.mocked(GoogleAuth).mock
      .instances[0] as unknown as GoogleAuthMockInstance;
    const callsBefore = instanceZero.getAccessToken.mock.calls.length;
    // Poison internal cache to simulate TTL expiry
    (service as unknown as { cachedToken: string; tokenExpiresAt: number }).cachedToken =
      'old-token';
    (service as unknown as { cachedToken: string; tokenExpiresAt: number }).tokenExpiresAt =
      Date.now() - 1;
    await service.getAccessToken();
    const callsAfter = instanceZero.getAccessToken.mock.calls.length;
    expect(callsAfter).toBeGreaterThan(callsBefore);
  });

  it('tokenReady flag is false before first call (lifecycle-aware stub safety)', () => {
    expect((service as unknown as { tokenReady: boolean }).tokenReady).toBe(false);
  });

  it('tokenReady flag is true after successful getAccessToken', async () => {
    await service.getAccessToken();
    expect((service as unknown as { tokenReady: boolean }).tokenReady).toBe(true);
  });
});
