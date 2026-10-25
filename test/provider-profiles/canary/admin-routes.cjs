/** Owned loopback canary: real compiled admin routes, guard, Prisma and disposable PG.
 * DATABASE_URL must name an owned disposable database. Never run against a service DB.
 * The stock graph HTTP producer measures route presence + unauthenticated refusal;
 * this harness separately measures authenticated readback and client isolation.
 */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { writeFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { Test } = require('@nestjs/testing');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { AdminController } = require('../../../dist/src/admin/admin.controller');
const { AdminService } = require('../../../dist/src/admin/admin.service');
const { AdminGuard } = require('../../../dist/src/admin/admin.guard');
const { PrismaService } = require('../../../dist/src/prisma/prisma.service');

async function main() {
  assert(
    process.argv.includes('--owned-disposable-database'),
    'disposable database assertion required',
  );
  const out = process.argv[2];
  assert(out, 'output path required');
  process.env.ADMIN_TOKEN = ['owned', 'canary', 'admin'].join('-');
  const prisma = new PrismaService();
  await prisma.$connect();
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminController],
    providers: [AdminGuard, { provide: AdminService, useValue: new AdminService(prisma) }],
  }).compile();
  const app = moduleRef.createNestApplication(new FastifyAdapter(), { logger: false });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await prisma.$disconnect();
  };
  process.once('SIGTERM', () => close().then(() => process.exit(0)));
  process.once('SIGINT', () => close().then(() => process.exit(0)));
  try {
    for (const id of ['a', 'b']) {
      const policy = {
        policyVersion: 2,
        profile: { id, revision: '1', accountingBucket: id },
        providers: ['deepseek'],
        providerKeys: { deepseek: [{ credentialRef: `${id}-deepseek`, version: '1' }] },
      };
      await prisma.apiKey.create({
        data: { id: `canary-${id}`, name: id, keyHash: `fixture-hash-${id}`, policy },
      });
      await prisma.request.create({
        data: {
          apiKeyId: `canary-${id}`,
          connector: 'deepseek',
          model: 'fixture-model',
          promptHash: 'fixture',
          promptLength: 0,
          latencyMs: 1,
          status: 'success',
          inputTokens: id === 'a' ? 7 : 97,
          totalTokens: id === 'a' ? 7 : 97,
          upstreamCredentialRef: `${id}-deepseek`,
          upstreamCredentialVersion: '1',
          accountingBucket: id,
        },
      });
    }
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const probes = [];
    for (const id of ['a', 'b']) {
      for (const route of ['policy', 'usage']) {
        const response = await fetch(`${base}/admin/keys/canary-${id}/${route}`, {
          headers: { 'x-admin-token': process.env.ADMIN_TOKEN },
        });
        assert.equal(response.status, 200);
        const body = await response.text();
        const data = JSON.parse(body);
        if (route === 'policy') assert.equal(data.policy.profile.id, id);
        else {
          assert.equal(data.length, 1);
          assert.equal(data[0].upstreamCredentialRef, `${id}-deepseek`);
          assert.equal(data[0]._count._all, 1);
          assert.equal(data[0]._sum.inputTokens, id === 'a' ? 7 : 97);
        }
        assert(!body.includes('keyHash'));
        probes.push({
          path: `/admin/keys/canary-${id}/${route}`,
          status: response.status,
          body_sha256: createHash('sha256').update(body).digest('hex'),
          checks: 'profile identity / client-scoped real-PG aggregates / no keyHash',
        });
      }
    }
    const files = [
      'admin/admin.controller.js',
      'admin/admin.service.js',
      'admin/admin.guard.js',
      'prisma/prisma.service.js',
    ];
    writeFileSync(
      out,
      JSON.stringify(
        {
          schema: 'AdminRouteCanaryReadback/v1',
          captured_at_utc: new Date().toISOString(),
          base_url: base,
          pid: process.pid,
          environment:
            'owned loopback Nest admin application + disposable Unix-socket PostgreSQL; no upstream providers',
          probes,
          loaded_files: files.map((file) => ({
            path: `dist/src/${file}`,
            sha256: createHash('sha256')
              .update(readFileSync(resolve(__dirname, '../../../dist/src', file)))
              .digest('hex'),
          })),
        },
        null,
        2,
      ) + '\n',
    );
  } catch (error) {
    await close();
    throw error;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
