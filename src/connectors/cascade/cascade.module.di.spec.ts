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
 * Root cause of the historical root-suite beforeAll blank failure:
 * the previous harness dynamically imported the entire AppModule graph
 * (Prisma/Redis/getConfig seed + every connector) inside beforeAll. Under
 * Vitest's default hookTimeout (10s), a cold transform of that graph on a
 * contended host exceeded the budget; the JSON reporter then dropped the
 * empty hook Error.message, yielding an opaque suite failure while the
 * focused file still passed. Raising the per-hook budget alone masks load;
 * compiling CascadeModule itself (with ConnectorsModule overridden to a
 * stub that still exports ConnectorsService) asserts the same DI wiring
 * without AppModule bootstrap cost or ambient DATABASE_URL seeding.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';

describe('CascadeModule DI bootstrap (CONN-0223)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let CascadeModule: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ConnectorsModule: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let CascadeRouterService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ConnectorsService: any;

  // CascadeModule still pulls connectors.module.ts for the overrideModule
  // token; keep a generous hook budget so cold transform under host load
  // cannot collapse into an empty beforeAll failure again.
  beforeAll(async () => {
    try {
      ({ CascadeModule } = await import('./cascade.module'));
      ({ ConnectorsModule } = await import('../connectors.module'));
      ({ CascadeRouterService } = await import('./cascade-router.service'));
      ({ ConnectorsService } = await import('../connectors.service'));
    } catch (err) {
      // Vitest JSON reporters have dropped empty Error.message on this hook;
      // always rethrow a non-empty diagnostic so the suite failure names the cause.
      const detail =
        err instanceof Error ? err.message || err.name || 'Error with empty message' : String(err);
      throw new Error(
        `CascadeModule DI beforeAll failed while importing CascadeModule graph: ${detail}`,
      );
    }
  }, 60_000);

  it('resolves CascadeRouterService through CascadeModule wiring', async () => {
    @Module({
      providers: [{ provide: ConnectorsService, useValue: { register() {} } }],
      exports: [ConnectorsService],
    })
    class StubConnectorsModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [CascadeModule],
    })
      // ConnectorsModule is the real forwardRef import CascadeModule declares;
      // override it so we assert CascadeModule's import list + MetricsModule
      // resolution without booting every connector provider.
      .overrideModule(ConnectorsModule)
      .useModule(StubConnectorsModule)
      .compile();

    const cascade = moduleRef.get(CascadeRouterService, { strict: false });
    expect(cascade).toBeInstanceOf(CascadeRouterService);

    await moduleRef.close();
  }, 60_000);
});
