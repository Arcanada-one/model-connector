'use strict';

// Explicitly invoked synthetic storage probe. It never starts a provider CLI.
// DATABASE_URL selects the authorized database. Only a newly generated inactive
// key and its synthetic Request row are written, read back, then deleted.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const dist = existsSync(path.join(root, 'dist/src/connectors')) ? 'dist/src' : 'dist';
const { ClaudeCodeConnector } = require(
  path.join(root, dist, 'connectors/claude-code/claude-code.connector'),
);
const { ConnectorsService } = require(path.join(root, dist, 'connectors/connectors.service'));
const { PrismaService } = require(path.join(root, dist, 'prisma/prisma.service'));
const { OutputGuardMiddleware } = require(
  path.join(root, dist, 'connectors/output-guard/output-guard.middleware'),
);

const cause = 'Synthetic upstream limit; enabled=true; resets at 16:00 UTC.';
const expected = `[subtype=success] ${cause}`;
const fixture = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: cause,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
});

class SyntheticClaude extends ClaudeCodeConnector {
  getBinaryPath() {
    return process.execPath;
  }
  buildArgs() {
    return ['-e', `process.stdout.write(${JSON.stringify(fixture)})`];
  }
}

async function main() {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const db = new PrismaService();
  const keyId = randomUUID();
  const marker = `synthetic-error-readback-${keyId}`;
  let created = false;
  let verified = false;
  try {
    await db.$connect();
    await db.apiKey.create({
      data: {
        id: keyId,
        name: marker,
        active: false,
        rateLimit: 1,
        keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      },
    });
    created = true;
    // This isolated service has only the synthetic connector registered and no
    // billing/queue worker. The serving application's registry is untouched.
    const access = {
      seedDefaults: async () => {},
      refresh: async () => {},
      getAccess: () => ({ read: true, use: true }),
    };
    const service = new ConnectorsService(
      {
        add: () => {
          throw new Error('Unexpected queue dispatch');
        },
      },
      db,
      { record: () => {} },
      new OutputGuardMiddleware({ enabled: false, maxRetries: 0, timeoutMs: 5000 }),
      undefined,
      { findAll: async () => [] },
      null,
      access,
    );
    const connector = new SyntheticClaude();
    connector.setSemaphore(1);
    service.register(connector);
    const response = await service.execute(
      'claude-code',
      {
        prompt: marker,
        model: 'synthetic-error-fixture',
        maxRetries: 0,
        timeout: 5000,
      },
      keyId,
    );
    assert.equal(response.status, 'error');
    assert.equal(response.result, '');
    assert.equal(response.error.message, expected);
    // Reconnect after the service's transaction commits: a mocked create call
    // or an uncommitted row cannot satisfy this readback.
    await db.$disconnect();
    await db.$connect();
    const rows = await db.request.findMany({ where: { apiKeyId: keyId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'error');
    assert.equal(rows[0].errorType, 'execution_error');
    assert.equal(rows[0].errorMessage, expected);
    assert.equal(Number(rows[0].costUsd), 0);
    verified = true;
  } finally {
    if (created) {
      await db.$transaction([
        db.request.deleteMany({ where: { apiKeyId: keyId } }),
        db.apiKey.delete({ where: { id: keyId } }),
      ]);
      assert.equal(await db.request.count({ where: { apiKeyId: keyId } }), 0);
      assert.equal(await db.apiKey.count({ where: { id: keyId } }), 0);
    }
    await db.$disconnect();
  }
  assert(verified);
  console.log(
    JSON.stringify({
      schema: 'SyntheticErrorReadback/v1',
      verified: true,
      cli_process: 'synthetic-node-fixture',
      provider_calls: 0,
      stored_message: expected,
      stored_rows: 1,
      remaining_owned_rows: 0,
      usage_cost_usd: 0,
      build_sha: process.env.MC_BUILD_SHA || null,
    }),
  );
}

main().catch((error) => {
  // Do not echo raw database/provider exceptions or connection strings.
  console.error(JSON.stringify({ verified: false, category: error.name || 'Error' }));
  process.exitCode = 1;
});
