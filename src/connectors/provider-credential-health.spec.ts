import { describe, expect, it, vi } from 'vitest';
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

  it('authenticates OpenRouter using a registered profile credential with a non-generative GET', async () => {
    const secret = 'synthetic-private-test-key';
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const d = deps({
      env: {
        PROVIDER_CREDENTIAL_REGISTRY: JSON.stringify({
          prime: {
            provider: 'openrouter',
            profileId: 'prime-critic',
            clientKeyIds: ['client-a'],
            versions: { v1: 'OPENROUTER_API_KEY_PRIME' },
          },
        }),
        OPENROUTER_API_KEY_PRIME: secret,
      },
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

  it('uses Claude Code auth status JSON and treats no login as missing', async () => {
    const runCommand = vi.fn(async () => ({ code: 0, stdout: '{"authMethod":"none"}' }));
    const service = new ProviderCredentialHealthService(deps({ runCommand }));

    await expect(service.check('claude-code')).resolves.toMatchObject({ state: 'missing' });
    expect(runCommand).toHaveBeenCalledWith('claude', ['auth', 'status']);
  });

  it('accepts authenticated Claude and Cursor status probes without exposing command output', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '{"authMethod":"claude.ai","email":"private@example.test"}' })
      .mockResolvedValueOnce({ code: 0, stdout: 'Authenticated as private@example.test' });
    const service = new ProviderCredentialHealthService(deps({ runCommand }));

    const results = await service.checkAdvertised(['claude-code', 'cursor']);

    expect(results.map((result) => result.state)).toEqual(['ready', 'ready']);
    expect(JSON.stringify(results)).not.toContain('private@example.test');
  });

  it('fails closed when Cursor reports unauthenticated', async () => {
    const service = new ProviderCredentialHealthService(
      deps({ runCommand: vi.fn(async () => ({ code: 1, stdout: 'Not authenticated' })) }),
    );

    await expect(service.check('cursor')).resolves.toMatchObject({ state: 'missing' });
  });
});
