import { GoogleAuth } from 'google-auth-library';

const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes (tokens expire at 60 min)

/**
 * Fetches and caches Google Cloud access tokens for Vertex AI.
 * Per memory `feedback_lifecycle_aware_stubs`: gates methods via `tokenReady` flag.
 */
export class VertexAuthService {
  private auth: GoogleAuth;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  /** Guards against stale stubs: true after first successful getAccessToken() */
  private tokenReady = false;

  constructor(
    private readonly projectId: string,
    private readonly location: string,
    serviceAccountJson?: string,
  ) {
    const credentials = serviceAccountJson ? JSON.parse(serviceAccountJson) : undefined;
    this.auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const result = await this.auth.getAccessToken();
    // getAccessToken may return a string or an object with a token property
    const token =
      typeof result === 'string' ? result : (result as { token?: string } | null)?.token;
    if (!token) throw new Error('VertexAuthService: received empty access token');

    this.cachedToken = token;
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    this.tokenReady = true;

    return token;
  }

  get projectIdValue(): string {
    return this.projectId;
  }

  get locationValue(): string {
    return this.location;
  }

  /**
   * Exposed for lifecycle-aware stub safety checks in tests.
   */
  get isTokenReady(): boolean {
    return this.tokenReady;
  }
}
