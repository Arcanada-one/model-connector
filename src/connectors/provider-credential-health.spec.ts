import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProviderCredentialHealthService,
  type CredentialHealthDeps,
} from './provider-credential-health';

function deps(overrides: Partial<CredentialHealthDeps> = {}): CredentialHealthDeps {
  return {
    env: {},
    fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
    runCommand: vi.fn(async () => ({ code: 0, stdout: '' })),
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ProviderCredentialHealthService', () => {
  it('reports a missing OpenRouter credential without an outbound probe', async () => {
    const d = deps();
    const service = new ProviderCredentialHealthService(d);

    await expect(service.check('openrouter')).resolves.toMatchObject({
      connector: 'openrouter',
      state: 'missing',
      required: false,
    });
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('authenticates OpenRouter from its configured deployment key with a non-generative GET', async () => {
    const secret = 'synthetic-private-test-key';
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const d = deps({
      env: { OPENROUTER_API_KEY: secret },
      fetchImpl,
    });
    const service = new ProviderCredentialHealthService(d);

    const result = await service.check('openrouter');

    expect(result?.state).toBe('ready');
    expect(result).not.toHaveProperty('credential');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(service.isReady('openrouter')).toBe(true);
  });

  it('does not treat another client profile binding as the shared OpenRouter credential', async () => {
    const profileKey = 'synthetic-profile-only-key';
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const service = new ProviderCredentialHealthService(
      deps({ env: { OPENROUTER_API_KEY_PRIME: profileKey }, fetchImpl }),
    );

    await expect(service.check('openrouter')).resolves.toMatchObject({ state: 'missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.isReady('openrouter')).toBe(false);

    await expect(service.checkCredential('openrouter', profileKey)).resolves.toMatchObject({
      state: 'ready',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(service.status('openrouter'))).not.toContain(profileKey);
  });

  it('single-flights concurrent checks for the same credential', async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(null, { status: 200 });
    });
    const service = new ProviderCredentialHealthService(
      deps({ env: { OPENROUTER_API_KEY: 'synthetic-concurrent-key' }, fetchImpl }),
    );

    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.check('openrouter', true)),
    );

    expect(results).toHaveLength(50);
    expect(results.every((result) => result?.state === 'ready')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an invalid upstream credential and does not issue a generation request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const service = new ProviderCredentialHealthService(
      deps({ env: { OPENROUTER_API_KEY: 'synthetic-invalid-key' }, fetchImpl }),
    );

    await expect(service.check('openrouter')).resolves.toMatchObject({ state: 'rejected' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('chat/completions');
  });

  it('marks DeepSeek as required and fails closed when its configured key is rejected', async () => {
    const service = new ProviderCredentialHealthService(
      deps({
        env: { DEEPSEEK_API_KEY: 'synthetic-invalid-key' },
        fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 403 })),
      }),
    );

    await expect(service.check('deepseek')).resolves.toMatchObject({
      state: 'rejected',
      required: true,
    });
  });

  it('honors the configured DeepSeek base URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const service = new ProviderCredentialHealthService(
      deps({
        env: {
          DEEPSEEK_API_KEY: 'synthetic-deepseek-key',
          DEEPSEEK_BASE_URL: 'http://127.0.0.1:45123/',
        },
        fetchImpl,
      }),
    );

    await service.check('deepseek');

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:45123/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses Claude Code auth status JSON and treats no login as missing', async () => {
    const runCommand = vi.fn(async () => ({ code: 0, stdout: '{"authMethod":"none"}' }));
    const service = new ProviderCredentialHealthService(deps({ runCommand }));

    await expect(service.check('claude-code')).resolves.toMatchObject({ state: 'missing' });
    expect(runCommand).toHaveBeenCalledWith('claude', ['auth', 'status']);
  });

  it('accepts authenticated Claude and Cursor status probes without exposing command output', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: '{"authMethod":"claude.ai","email":"private@example.test"}',
      })
      .mockResolvedValueOnce({ code: 0, stdout: 'Authenticated as private@example.test' });
    const service = new ProviderCredentialHealthService(deps({ runCommand }));

    const results = await service.checkAdvertised(['claude-code', 'cursor']);

    expect(results.map((result) => result.state)).toEqual(['ready', 'ready']);
    expect(JSON.stringify(results)).not.toContain('private@example.test');
  });

  it('does not treat Claude authMethod as logged in when loggedIn is explicitly false', async () => {
    const service = new ProviderCredentialHealthService(
      deps({
        runCommand: vi.fn(async () => ({
          code: 0,
          stdout: '{"loggedIn":false,"authMethod":"oauth_token"}',
        })),
      }),
    );

    await expect(service.check('claude-code')).resolves.toMatchObject({ state: 'missing' });
  });

  it('fails closed when Cursor reports unauthenticated', async () => {
    const service = new ProviderCredentialHealthService(
      deps({ runCommand: vi.fn(async () => ({ code: 1, stdout: 'Not authenticated' })) }),
    );

    await expect(service.check('cursor')).resolves.toMatchObject({ state: 'missing' });
  });

  it('keeps Groq out of failover until its API credential passes a models probe', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const service = new ProviderCredentialHealthService(
      deps({ env: { GROQ_API_KEY: 'synthetic-groq-key' }, fetchImpl }),
    );

    await expect(service.check('groq')).resolves.toMatchObject({ state: 'rejected' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('checks the selected Gemini CLI OAuth profile without invoking a prompt or generation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mc-gemini-auth-'));
    const geminiDir = join(home, '.gemini');
    await mkdir(geminiDir);
    await writeFile(
      join(geminiDir, 'settings.json'),
      JSON.stringify({ selectedAuthType: 'oauth-personal' }),
    );
    await writeFile(
      join(geminiDir, 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'synthetic-access-token',
        refresh_token: 'synthetic-refresh-token',
        expiry_date: 1,
      }),
    );
    const runCommand = vi.fn(async () => ({ code: 0, stdout: 'This must not be invoked' }));
    const service = new ProviderCredentialHealthService(deps({ env: { HOME: home }, runCommand }));

    try {
      await expect(service.check('gemini')).resolves.toMatchObject({ state: 'ready' });
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports Gemini CLI auth missing when the selected OAuth profile has no saved credential', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mc-gemini-auth-'));
    const geminiDir = join(home, '.gemini');
    await mkdir(geminiDir);
    await writeFile(
      join(geminiDir, 'settings.json'),
      JSON.stringify({ selectedAuthType: 'oauth-personal' }),
    );
    const runCommand = vi.fn(async () => ({ code: 0, stdout: 'Not logged in' }));
    const service = new ProviderCredentialHealthService(deps({ env: { HOME: home }, runCommand }));

    try {
      await expect(service.check('gemini')).resolves.toMatchObject({ state: 'missing' });
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('probes Gemini API keys with x-goog-api-key and no generation request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const service = new ProviderCredentialHealthService(
      deps({ env: { GEMINI_API_KEY: 'synthetic-gemini-key' }, fetchImpl }),
    );

    await expect(service.check('gemini-api')).resolves.toMatchObject({ state: 'ready' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models',
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-goog-api-key': 'synthetic-gemini-key' },
      }),
    );
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('generateContent');
  });
});
