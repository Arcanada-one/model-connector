import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';

// Only the maintained isolated executor enables this suite. Default runs stay offline.
const isolated = process.env.MC_DISPOSABLE_APP_E2E === '1';
if (
  isolated &&
  (process.env.REDIS_HOST !== 'mc-redis' ||
    !process.env.DATABASE_URL?.startsWith('postgresql://test:test@mc-pg:5432/connector_test') ||
    process.env.MC_NO_EGRESS !== '1')
) {
  throw new Error('AppE2E refused: disposable service identities/no-egress guard absent');
}
describe.runIf(isolated)('App E2E (requires infra)', () => {
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

  it('POST /execute without auth should return 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/execute',
      payload: { connector: 'test', prompt: 'hello' },
    });
    expect(response.statusCode).toBe(401);
  });
});
