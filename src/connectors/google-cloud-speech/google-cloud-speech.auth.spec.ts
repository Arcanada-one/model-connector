import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  options: [] as unknown[],
  token: { token: 'adc-synthetic-token' } as string | { token?: string | null } | null,
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: unknown) {
      authState.options.push(options);
    }

    async getAccessToken() {
      return authState.token;
    }
  },
}));

import { GOOGLE_CLOUD_PLATFORM_SCOPE, GoogleCloudSpeechAuth } from './google-cloud-speech.auth';

describe('GoogleCloudSpeechAuth', () => {
  beforeEach(() => {
    authState.options.length = 0;
    authState.token = { token: 'adc-synthetic-token' };
  });

  it('wraps an injected auth client and attaches Bearer plus quota-project headers', async () => {
    const client = new GoogleCloudSpeechAuth({
      auth: { getAccessToken: async () => 'injected-synthetic-token' },
      quotaProjectId: 'synthetic-quota-project',
    });
    await expect(client.getRequestHeaders()).resolves.toEqual({
      authorization: 'Bearer injected-synthetic-token',
      'x-goog-user-project': 'synthetic-quota-project',
    });
  });

  it('creates ADC with exactly the cloud-platform OAuth scope', async () => {
    const client = GoogleCloudSpeechAuth.fromApplicationDefaultCredentials({
      quotaProjectId: 'synthetic-quota-project',
    });
    await expect(client.getAccessToken()).resolves.toBe('adc-synthetic-token');
    expect(GOOGLE_CLOUD_PLATFORM_SCOPE).toBe('https://www.googleapis.com/auth/cloud-platform');
    expect(authState.options).toEqual([{ scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE] }]);
  });

  it('accepts both google-auth-library token return forms', async () => {
    const client = GoogleCloudSpeechAuth.fromApplicationDefaultCredentials({});
    authState.token = 'direct-synthetic-token';
    await expect(client.getAccessToken()).resolves.toBe('direct-synthetic-token');
    authState.token = { token: 'object-synthetic-token' };
    await expect(client.getAccessToken()).resolves.toBe('object-synthetic-token');
  });

  it('fails closed when ADC does not return a usable token', async () => {
    const client = GoogleCloudSpeechAuth.fromApplicationDefaultCredentials({});
    authState.token = { token: '' };
    await expect(client.getRequestHeaders()).rejects.toThrow(/empty access token/i);
    authState.token = null;
    await expect(client.getRequestHeaders()).rejects.toThrow(/empty access token/i);
  });
});
