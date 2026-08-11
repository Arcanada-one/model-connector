import { GoogleAuth } from 'google-auth-library';
import type { GoogleAuthHeadersProvider } from './google-cloud-speech.types';

export const GOOGLE_CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform' as const;

type GoogleAccessTokenResult = string | { token?: string | null } | null | undefined;

export interface GoogleAuthLike {
  getAccessToken(): Promise<GoogleAccessTokenResult>;
}

export interface GoogleCloudSpeechAuthOptions {
  auth: GoogleAuthLike;
  quotaProjectId?: string;
}

export interface ApplicationDefaultCredentialsOptions {
  quotaProjectId?: string;
}

export class GoogleCloudSpeechAuth implements GoogleAuthHeadersProvider {
  private readonly auth: GoogleAuthLike;
  private readonly quotaProjectId?: string;

  constructor(options: GoogleCloudSpeechAuthOptions) {
    this.auth = options.auth;
    this.quotaProjectId = normalizeQuotaProject(options.quotaProjectId);
  }

  static fromApplicationDefaultCredentials(
    options: ApplicationDefaultCredentialsOptions,
  ): GoogleCloudSpeechAuth {
    return new GoogleCloudSpeechAuth({
      auth: new GoogleAuth({ scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE] }),
      quotaProjectId: options.quotaProjectId,
    });
  }

  async getAccessToken(): Promise<string> {
    const result = await this.auth.getAccessToken();
    const token = typeof result === 'string' ? result : result?.token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Application Default Credentials returned an empty access token');
    }
    return token;
  }

  async getRequestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.getAccessToken()}`,
    };
    if (this.quotaProjectId !== undefined) {
      headers['x-goog-user-project'] = this.quotaProjectId;
    }
    return headers;
  }
}

function normalizeQuotaProject(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error('quotaProjectId must not be empty');
  }
  return normalized;
}
