#!/usr/bin/env node
/**
 * Real disposable app-e2e arm probe for FullSuiteArmEvidence/v1.
 * Green: loopback HTTP health server + Redis namespace check (owned disposable).
 * Red: health server closed before request must fail (PASS_RED).
 * Usage: node app-e2e.probe.mjs green|red
 */
import http from 'node:http';
import Redis from 'ioredis';

const mode = process.argv[2];
if (mode !== 'green' && mode !== 'red') {
  console.error('usage: app-e2e.probe.mjs green|red');
  process.exit(2);
}

const host = process.env.REDIS_HOST || '127.0.0.1';
const port = Number(process.env.REDIS_PORT || 6379);
const prefix = process.env.REDIS_PREFIX || `mc-full-suite-e2e:${process.pid}:`;

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
    server.on('error', reject);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    }).on('error', reject);
  });
}

async function withRedis(fn) {
  const client = new Redis({ host, port, connectTimeout: 2000, lazyConnect: true, maxRetriesPerRequest: 1 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.quit(); } catch { client.disconnect(); }
  }
}

async function green() {
  await withRedis(async (redis) => {
    const key = `${prefix}ready`;
    await redis.set(key, '1', 'EX', 30);
    const { server, port: localPort } = await listen(async (req, res) => {
      if (req.url === '/health') {
        const ready = await redis.get(key);
        res.writeHead(ready === '1' ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: ready === '1' ? 'ok' : 'not-ready' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const health = await get(`http://127.0.0.1:${localPort}/health`);
      if (health.status !== 200 || JSON.parse(health.body).status !== 'ok') {
        throw new Error('health_not_ok');
      }
      const denied = await get(`http://127.0.0.1:${localPort}/execute`);
      if (denied.status !== 404) throw new Error('unexpected_execute_status');
      await redis.del(key);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  process.stdout.write(JSON.stringify({ passed: 2, failed: 0, skipped: 0 }) + '\n');
}

async function red() {
  const { server, port: localPort } = await listen((_req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  await new Promise((resolve) => server.close(resolve));
  try {
    await get(`http://127.0.0.1:${localPort}/health`);
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
