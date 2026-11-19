#!/usr/bin/env node
/**
 * Real disposable-store arm probe for FullSuiteArmEvidence/v1.
 * Green: owned Redis namespace SET/GET/DEL. Red: closed port must fail.
 * Usage: node disposable-store.probe.mjs green|red
 */
import net from 'node:net';
import Redis from 'ioredis';

const mode = process.argv[2];
if (mode !== 'green' && mode !== 'red') {
  console.error('usage: disposable-store.probe.mjs green|red');
  process.exit(2);
}

const host = process.env.REDIS_HOST || '127.0.0.1';
const port = Number(process.env.REDIS_PORT || 6379);
const prefix = process.env.REDIS_PREFIX || `mc-full-suite-arm:${process.pid}:`;

async function green() {
  const client = new Redis({ host, port, connectTimeout: 2000, lazyConnect: true, maxRetriesPerRequest: 1 });
  await client.connect();
  const key = `${prefix}probe`;
  await client.set(key, 'ok', 'EX', 30);
  const value = await client.get(key);
  await client.del(key);
  await client.quit();
  if (value !== 'ok') throw new Error('redis_roundtrip_mismatch');
  process.stdout.write(JSON.stringify({ passed: 1, failed: 0, skipped: 0 }) + '\n');
}

async function red() {
  const closed = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address();
      server.close(() => resolve(p));
    });
  });
  const client = new Redis({
    host: '127.0.0.1',
    port: closed,
    connectTimeout: 500,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.ping();
    await client.quit();
    throw new Error('PASS_RED_EXPECTED_FAILURE');
  } catch (error) {
    try { client.disconnect(); } catch { /* ignore */ }
    if (error && error.message === 'PASS_RED_EXPECTED_FAILURE') throw error;
    process.stdout.write(JSON.stringify({ passed: 0, failed: 1, skipped: 0 }) + '\n');
    process.exit(1);
  }
}

(mode === 'green' ? green() : red()).catch((error) => {
  console.error(String(error && error.stack || error));
  process.exit(1);
});
