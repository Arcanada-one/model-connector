import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const root = path.resolve('node_modules/.cache/mc207-eac9f93/http');
const auth = fs.readFileSync(path.join(root, 'client-auth'), 'utf8').trim();
const admin = fs.readFileSync(path.join(root, 'admin-token'), 'utf8').trim();
const watcher = fs.readFileSync(path.join(root, 'watcher-token'), 'utf8').trim();
const body = fs.readFileSync(path.join(root, 'route-body.json'));
const shim = fs.readFileSync(path.join(root, 'noegress.cjs'));
const specs = [
  { id: 'route-6c3c9563ecfe-authorized', method: 'GET', path: '/connectors/intents/canary', body_sha256: null },
  { id: 'route-d5430ba59c42-authorized', method: 'POST', path: '/connectors/deepseek/chat/completions', body_sha256: sha(body) },
  { id: 'route-7dd41765b35c-authorized', method: 'POST', path: '/v1/speech/stt', body_sha256: sha(body) },
  { id: 'route-5b74b3d2e5a3-authorized', method: 'POST', path: '/v1/speech/stt/async', body_sha256: sha(body) },
];
const shimSha = sha(shim);
const requestPlan = { schema: 'SameRequestParityPlan/v1', auth_header_names: ['Authorization', 'X-Admin-Token', 'X-Watcher-Repair-Token'], content_type: 'application/json', noegress_shim_sha256: shimSha, probes: specs };
const planDigest = sha(Buffer.from(canonical(requestPlan)));
const runs = {};
for (const [label, base] of [['candidate', 'http://127.0.0.1:13901'], ['main', 'http://127.0.0.1:13902']]) {
  runs[label] = [];
  for (const spec of specs) {
    const response = await fetch(`${base}${spec.path}`, {
      method: spec.method,
      headers: { Authorization: auth, 'X-Admin-Token': admin, 'X-Watcher-Repair-Token': watcher, ...(spec.body_sha256 ? { 'Content-Type': 'application/json' } : {}) },
      ...(spec.body_sha256 ? { body } : {}),
    });
    const responseBytes = Buffer.from(await response.arrayBuffer());
    const text = responseBytes.toString('utf8');
    let errorCode = null;
    try { const parsed = JSON.parse(text); errorCode = parsed?.error?.code ?? parsed?.code ?? null; } catch {}
    runs[label].push({ id: spec.id, status: response.status, body_bytes: responseBytes.length, body_sha256: sha(responseBytes), error_code: errorCode });
  }
}
const result = { schema: 'SameRequestParityResult/v1', captured_at_utc: new Date().toISOString(), plan_digest: `sha256:${planDigest}`, harness_sha256: sha(fs.readFileSync(new URL(import.meta.url))), shim_sha256: shimSha, subjects: { candidate: 'eac9f9354f742ea628a4378b725fd28e3c4b79f9', main: 'bb70aae82e78678dfb4e8f13621582ae6bd8cf74' }, request_plan: requestPlan, runs };
fs.writeFileSync(path.join(root, 'base-parity', 'same-request-result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
for (const label of ['candidate', 'main']) for (const item of runs[label]) console.log(`${label}\t${item.id}\t${item.status}\t${item.error_code ?? 'none'}`);
console.log(`plan_digest\t${result.plan_digest}`);
function sha(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
