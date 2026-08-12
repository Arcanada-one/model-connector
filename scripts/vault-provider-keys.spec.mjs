import { describe, it, expect, vi } from 'vitest';
import { sourceProviderKeys, SECRETS } from './vault-provider-keys.mjs';

// CONN-1666: this script runs at container boot and sources per-agent OpenRouter
// keys from Vault into process env (never disk). It is fail-closed: a partial
// config or an unreadable secret must abort the boot rather than let an agent
// fall through to the shared key (which CONN-1665 forbids). These tests pin
// that contract; `fail` throws here so we can assert on it (in prod it exits 78).

const OK_LOGIN = { auth: { client_token: 'vault-token-xyz' } };
const okResp = (body) => ({ ok: true, status: 200, json: async () => body });
const errResp = (status) => ({ ok: false, status, json: async () => ({}) });

function keyBody(apiKey) {
  return { data: { data: { api_key: apiKey } } };
}

/** Build a fetch stub: login → OK_LOGIN, then each secret path → its body. */
function makeFetch({ login = okResp(OK_LOGIN), reads } = {}) {
  return vi.fn(async (url) => {
    if (url.endsWith('/v1/auth/approle/login')) return login;
    const hit = reads.find(([p]) => url.endsWith(`/v1/${p}`));
    if (!hit) throw new Error(`unexpected url ${url}`);
    return hit[1];
  });
}

const failThrows = (msg) => {
  throw new Error(`FAIL: ${msg}`);
};

describe('sourceProviderKeys (CONN-1666)', () => {
  const activeEnv = {
    MC_VAULT_ROLE_ID: 'role-1',
    MC_VAULT_SECRET_ID: 'secret-1',
    VAULT_ADDR: 'http://vault.test:8200',
  };

  it('no-op (returns 0, emits nothing) when Vault sourcing is disabled', async () => {
    const emit = vi.fn();
    const fetchImpl = vi.fn();
    const n = await sourceProviderKeys({ env: {}, fetchImpl, emit, fail: failThrows });
    expect(n).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('emits one export line per secret with the exact env var names', async () => {
    const emit = vi.fn();
    const fetchImpl = makeFetch({
      reads: [
        [SECRETS[0][0], okResp(keyBody('sk-or-email-agent'))],
        [SECRETS[1][0], okResp(keyBody('sk-or-agents-free'))],
      ],
    });
    const n = await sourceProviderKeys({ env: activeEnv, fetchImpl, emit, fail: failThrows });
    expect(n).toBe(2);
    expect(emit).toHaveBeenCalledWith("export OPENROUTER_API_KEY_EMAIL_AGENT='sk-or-email-agent'");
    expect(emit).toHaveBeenCalledWith("export OPENROUTER_API_KEY_AGENTS_FREE='sk-or-agents-free'");
  });

  it('fails closed when the role id is set but the secret id is empty', async () => {
    await expect(
      sourceProviderKeys({
        env: { MC_VAULT_ROLE_ID: 'role-1', VAULT_ADDR: 'http://vault.test:8200' },
        fetchImpl: vi.fn(),
        emit: vi.fn(),
        fail: failThrows,
      }),
    ).rejects.toThrow(/MC_VAULT_SECRET_ID/);
  });

  it('fails closed on a non-200 approle login (no partial env)', async () => {
    const emit = vi.fn();
    await expect(
      sourceProviderKeys({
        env: activeEnv,
        fetchImpl: makeFetch({ login: errResp(400), reads: [] }),
        emit,
        fail: failThrows,
      }),
    ).rejects.toThrow(/approle login HTTP 400/);
    expect(emit).not.toHaveBeenCalled();
  });

  it('fails closed on a 403 secret read (no fallback to the shared key)', async () => {
    await expect(
      sourceProviderKeys({
        env: activeEnv,
        fetchImpl: makeFetch({ reads: [[SECRETS[0][0], errResp(403)]] }),
        emit: vi.fn(),
        fail: failThrows,
      }),
    ).rejects.toThrow(/read .* HTTP 403/);
  });

  it('fails closed when the secret has no api_key field', async () => {
    await expect(
      sourceProviderKeys({
        env: activeEnv,
        fetchImpl: makeFetch({ reads: [[SECRETS[0][0], okResp({ data: { data: {} } })]] }),
        emit: vi.fn(),
        fail: failThrows,
      }),
    ).rejects.toThrow(/no string field "api_key"/);
  });

  it('fails closed on a quote-injecting key value (eval break-out guard)', async () => {
    await expect(
      sourceProviderKeys({
        env: activeEnv,
        fetchImpl: makeFetch({ reads: [[SECRETS[0][0], okResp(keyBody("sk'; rm -rf /"))]] }),
        emit: vi.fn(),
        fail: failThrows,
      }),
    ).rejects.toThrow(/contains a quote character/);
  });

  it('fails closed when login returns no client_token', async () => {
    await expect(
      sourceProviderKeys({
        env: activeEnv,
        fetchImpl: makeFetch({ login: okResp({ auth: {} }), reads: [] }),
        emit: vi.fn(),
        fail: failThrows,
      }),
    ).rejects.toThrow(/no client_token/);
  });
});
