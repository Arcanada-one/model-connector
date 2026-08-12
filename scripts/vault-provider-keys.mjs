#!/usr/bin/env node
// CONN-1666: fetch per-agent OpenRouter provider keys from Vault at container
// boot and emit `export KEY='value'` lines for the entrypoint to eval — the
// key values live only in process env, never on disk and never in logs.
//
// Contract:
// - Activates only when MC_VAULT_ROLE_ID is set; otherwise prints nothing and
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

const SECRETS = [
  ['arcanada/data/shared/tokens/openrouter-email-agent', 'OPENROUTER_API_KEY_EMAIL_AGENT'],
  ['arcanada/data/shared/tokens/openrouter-agents-free', 'OPENROUTER_API_KEY_AGENTS_FREE'],
];

const roleId = process.env.MC_VAULT_ROLE_ID;
const secretId = process.env.MC_VAULT_SECRET_ID;
const addr = process.env.VAULT_ADDR;

if (!roleId) process.exit(0); // Vault sourcing not enabled — .env keys apply.

function fatal(msg) {
  console.error(`[vault-provider-keys] FATAL: ${msg}`);
  process.exit(78);
}

if (!secretId) fatal('MC_VAULT_ROLE_ID is set but MC_VAULT_SECRET_ID is empty');
if (!addr) fatal('MC_VAULT_ROLE_ID is set but VAULT_ADDR is empty');

const base = addr.replace(/\/+$/, '');

async function main() {
  let login;
  try {
    const r = await fetch(`${base}/v1/auth/approle/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) fatal(`approle login HTTP ${r.status}`);
    login = await r.json();
  } catch (e) {
    fatal(`approle login failed: ${e.cause?.code ?? e.message}`);
  }
  const token = login?.auth?.client_token;
  if (!token) fatal('approle login returned no client_token');

  for (const [path, envName] of SECRETS) {
    let value;
    try {
      const r = await fetch(`${base}/v1/${path}`, {
        headers: { 'X-Vault-Token': token },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) fatal(`read ${path} HTTP ${r.status}`);
      const body = await r.json();
      value = body?.data?.data?.api_key;
    } catch (e) {
      fatal(`read ${path} failed: ${e.cause?.code ?? e.message}`);
    }
    if (!value || typeof value !== 'string') fatal(`${path} has no string field "api_key"`);
    if (value.includes("'")) fatal(`${path} api_key contains a quote character`);
    process.stdout.write(`export ${envName}='${value}'\n`);
    console.error(`[vault-provider-keys] loaded ${envName} from ${path} (${value.length} chars)`);
  }
}

await main();
