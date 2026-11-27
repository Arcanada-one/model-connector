import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Nest AppModule e2e against disposable Postgres/Redis. Ambient hosts stay skipped.
// The full-suite grant sets MC_FULL_SUITE_APP_E2E=1 with DATABASE_URL/REDIS_* injected.
const shouldRun = process.env.MC_FULL_SUITE_APP_E2E === '1';

describe.skipIf(!shouldRun)('App E2E (Nest AppModule against disposable stores)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health should be public and return ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('GET /health/ready should be public', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    // 503 when required provider credentials are missing is still a public reply.
    expect([200, 503]).toContain(response.statusCode);
    expect(response.statusCode).not.toBe(401);
  });

  // PASS_RED tripwire: broken DATABASE_URL must fail; real grant must pass.
  it('Prisma SELECT 1 against disposable DATABASE_URL', async () => {
    const prisma = app.get(PrismaService);
    await expect(prisma.$queryRaw`SELECT 1`).resolves.toBeTruthy();
  });

  it('POST /execute without auth should return 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/execute',
      payload: { connector: 'test', prompt: 'hello' },
    });
    expect(response.statusCode).toBe(401);
  });
});
