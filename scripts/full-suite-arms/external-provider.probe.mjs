#!/usr/bin/env node
/**
 * Real external-provider arm probe for FullSuiteArmEvidence/v1.
 * Green: HTTPS GET to a public Cloudflare edge trace endpoint.
 * Red: DNS-impossible host must fail (PASS_RED).
 * Usage: node external-provider.probe.mjs green|red
 */
import https from 'node:https';

const mode = process.argv[2];
if (mode !== 'green' && mode !== 'red') {
  console.error('usage: external-provider.probe.mjs green|red');
  process.exit(2);
}

function request(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'mc-full-suite-arm/1' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function green() {
  const { status, body } = await request('https://cloudflare.com/cdn-cgi/trace');
  if (status < 200 || status >= 400) throw new Error(`unexpected_status_${status}`);
  if (!body.includes('fl=') && !body.includes('ip=')) throw new Error('trace_body_missing');
  process.stdout.write(JSON.stringify({ passed: 1, failed: 0, skipped: 0 }) + '\n');
}

async function red() {
  try {
    await request('https://no-such-host.invalid./cdn-cgi/trace', 2000);
    throw new Error('PASS_RED_EXPECTED_FAILURE');
  } catch (error) {
    if (error && error.message === 'PASS_RED_EXPECTED_FAILURE') throw error;
    process.stdout.write(JSON.stringify({ passed: 0, failed: 1, skipped: 0 }) + '\n');
    process.exit(1);
  }
}

(mode === 'green' ? green() : red()).catch((error) => {
  console.error(String(error && error.stack || error));
  process.exit(1);
});
