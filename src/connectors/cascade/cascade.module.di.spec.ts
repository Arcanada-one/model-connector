/**
 * CONN-0223 — DI bootstrap test for CascadeModule.
 *
 * Why this exists: the unit specs for CascadeRouterService mock its
 * constructor dependencies, so they pass even when the NestJS module graph
 * cannot actually resolve them. A missing `imports` entry in CascadeModule
 * (ConnectorsModule via forwardRef + MetricsModule) crashed the real
 * container at boot with `Nest can't resolve dependencies of the
 * CascadeRouterService (?, MetricsService)` — green unit tests, red prod.
 *
 * This test compiles the real module graph (no mocked DI) and asserts that
 * CascadeRouterService resolves. PrismaService is overridden so the test
 * needs no live Postgres; everything else is the production wiring.
 *
 * AppModule and PrismaService are imported dynamically AFTER DATABASE_URL is
 * seeded, because app.module.ts calls getConfig() at module-load time (static
 * imports are hoisted above top-level statements, so a static import would
 * validate env before the seed runs).
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';

describe('CascadeModule DI bootstrap (CONN-0223)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AppModule: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrismaService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let CascadeRouterService: any;

  beforeAll(async () => {
    // Minimal env so AppModule's eager getConfig() validation passes. Disable
    // optional providers that would otherwise demand their own API keys — this
    // test asserts DI wiring, not provider provisioning.
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    }
    process.env.STT_PROVIDER_GROQ_ENABLED = 'false';
    process.env.OPENMODEL_ENABLED = 'false';
    process.env.CASCADE_PAID_ENABLED = 'false';
    ({ AppModule } = await import('../../app.module'));
    ({ PrismaService } = await import('../../prisma/prisma.service'));
    ({ CascadeRouterService } = await import('./cascade-router.service'));
  });

  it('resolves CascadeRouterService through the real module graph', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Avoid a live DB connection at boot; DI resolution is what we assert.
      .overrideProvider(PrismaService)
      .useValue({
        onModuleInit: async () => {},
        onModuleDestroy: async () => {},
        $connect: async () => {},
        $disconnect: async () => {},
      })
      .compile();

    const cascade = moduleRef.get(CascadeRouterService, { strict: false });
    expect(cascade).toBeInstanceOf(CascadeRouterService);

    await moduleRef.close();
  }, 30_000);
});
