#!/usr/bin/env node
// CONN-1666: fetch per-agent OpenRouter provider keys from Vault at container
// boot and emit `export KEY='value'` lines for the entrypoint to eval — the
// key values live only in process env, never on disk and never in logs.
//
// Contract:
// - Activates only when MC_VAULT_ROLE_ID is set; otherwise emits nothing and
//   exits 0 (transition compat: .env-provided keys stay in effect).
// - When active, a partial config or an unreadable secret is FATAL (exit 78,
//   sysexits EX_CONFIG): a silently missing per-agent key would send that
//   agent's traffic through the shared key — exactly what CONN-1665 forbids.
// - stdout carries ONLY export lines (consumed by eval); all diagnostics go
//   to stderr and never include secret material.
//
// Vault layout (operator-provisioned 2026-08-12):
//   ${VAULT_ADDR}  http://100.97.136.74:8200  (KV v2 mount "arcanada")
//   arcanada/shared/tokens/openrouter-email-agent  field api_key
//   arcanada/shared/tokens/openrouter-agents-free  field api_key

export const SECRETS = [
  ['arcanada/data/shared/tokens/openrouter-email-agent', 'OPENROUTER_API_KEY_EMAIL_AGENT'],
  ['arcanada/data/shared/tokens/openrouter-agents-free', 'OPENROUTER_API_KEY_AGENTS_FREE'],
];

/**
 * Source per-agent provider keys from Vault. Pure of process globals — all
 * side-effecting dependencies are injected so this is unit-testable and the
 * production wrapper stays a one-liner.
 *
 * @param {object}   deps
 * @param {object}   deps.env        environment map (process.env in prod)
 * @param {Function} deps.fetchImpl  fetch(url, opts) => Response
 * @param {Function} deps.emit       (line) => void — receives one export line
 * @param {Function} deps.fail       (msg)  => never — MUST NOT return (throws/exits)
 * @returns {Promise<number>} count of keys sourced (0 when Vault sourcing is off)
 */
export async function sourceProviderKeys({ env, fetchImpl, emit, fail }) {
  const roleId = env.MC_VAULT_ROLE_ID;
  const secretId = env.MC_VAULT_SECRET_ID;
  const addr = env.VAULT_ADDR;

  if (!roleId) return 0; // Vault sourcing not enabled — .env keys apply.

  if (!secretId) return fail('MC_VAULT_ROLE_ID is set but MC_VAULT_SECRET_ID is empty');
  if (!addr) return fail('MC_VAULT_ROLE_ID is set but VAULT_ADDR is empty');

  const base = addr.replace(/\/+$/, '');

  let login;
  try {
    const r = await fetchImpl(`${base}/v1/auth/approle/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return fail(`approle login HTTP ${r.status}`);
    login = await r.json();
  } catch (e) {
    return fail(`approle login failed: ${e.cause?.code ?? e.message}`);
  }
  const token = login?.auth?.client_token;
  if (!token) return fail('approle login returned no client_token');

  let count = 0;
  for (const [path, envName] of SECRETS) {
    let value;
    try {
      const r = await fetchImpl(`${base}/v1/${path}`, {
        headers: { 'X-Vault-Token': token },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return fail(`read ${path} HTTP ${r.status}`);
      const body = await r.json();
      value = body?.data?.data?.api_key;
    } catch (e) {
      return fail(`read ${path} failed: ${e.cause?.code ?? e.message}`);
    }
    if (!value || typeof value !== 'string') return fail(`${path} has no string field "api_key"`);
    // Value is wrapped in single quotes for `eval` — a quote would break out.
    if (value.includes("'")) return fail(`${path} api_key contains a quote character`);
    emit(`export ${envName}='${value}'`);
    count += 1;
  }
  return count;
}

// Production wrapper: real deps, fail-loud via process.exit(78), stdout is the
// export stream. Guarded so importing this module in a test does not run it —
// pathToFileURL makes the comparison robust to relative argv and symlinks (a
// false-negative here would silently skip Vault sourcing at boot, which the
// free-only policy layer would then surface as config_error on every request).
const { pathToFileURL } = await import('node:url');
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const fail = (msg) => {
    console.error(`[vault-provider-keys] FATAL: ${msg}`);
    process.exit(78);
  };
  const emit = (line) => {
    process.stdout.write(line + '\n');
    // Log the env var name + length to stderr, never the value.
    const [, envName] = /^export (\w+)='(.*)'$/.exec(line) ?? [];
    console.error(`[vault-provider-keys] loaded ${envName} (sourced from Vault)`);
  };
  await sourceProviderKeys({ env: process.env, fetchImpl: fetch, emit, fail });
}
