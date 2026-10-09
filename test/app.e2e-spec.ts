import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';

// E2E needs Redis + PostgreSQL. It runs only when the caller owns disposable stores and says so
// with MC_OWNED_STORES=1 (scripts/graph_full_suite.py starts both on kernel-chosen endpoints,
// migrates the schema and tears them down). Without that flag the suite is skipped, never green.
// By hand: MC_OWNED_STORES=1 DATABASE_URL=<scratch db> REDIS_HOST=... REDIS_PORT=... pnpm test:e2e
describe.skipIf(process.env.MC_OWNED_STORES !== '1')('App E2E (owned disposable stores)', () => {
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
    expect(response.statusCode).toBe(200);
  });

  it('GET /connectors without auth should return 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/connectors' });
    expect(response.statusCode).toBe(401);
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
