import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConnectorsController } from '../connectors.controller';
import { perConnectorExecuteSchema } from '../dto/execute.dto';
import { ConnectorsService } from '../connectors.service';
import { DecisionService } from './decision.service';
import { JevConnector } from './jev.connector';
import { ConnectorsModule } from '../connectors.module';
import { PolicyService } from '../../policy/policy.service';
import { request, nativeResponse } from './decision.fixture';
import type { ApiKeyPolicy } from '../../policy/policy.schema';

// Real public service -> real policy choke point -> real native adapter -> synthetic transport.
function stack(policy: ApiKeyPolicy | null = null) {
  const prisma = {
    request: { create: vi.fn().mockResolvedValue({}) },
    apiKey: { findUnique: vi.fn().mockResolvedValue({ policy }) },
    modelCatalog: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma),
    firstDispatchObservation: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const service = new ConnectorsService(
    {} as never,
    prisma as never,
    { record: vi.fn() } as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    new PolicyService(prisma as never),
  );
  const adapter = new JevConnector();
  new ConnectorsModule(adapter, service).onModuleInit();
  return { service, decisions: new DecisionService(service), prisma };
}

describe('decision consumer wiring', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv('JEV_ENABLED', 'true');
    vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-key');
    vi.stubEnv('PROVIDER_ACCESS', '');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('traverses native adapter through ConnectorsService and records shadow provenance', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(nativeResponse)));
    const { decisions, prisma } = stack();
    const result = await decisions.evaluate(request, 'fixture-key');
    expect(result).toMatchObject({
      status: 'observed',
      action: 'none',
      observedModel: 'jev-fixture-version',
      answers: { tier: { confidence: 0.8 }, risk: { noul: 0.6996 } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.request.create).toHaveBeenCalled();
  });
  it('accepts the external execute DTO and returns native structured output through the existing controller', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(nativeResponse)));
    const { service } = stack();
    const controller = new ConnectorsController(service, {} as never, {} as never);
    const body = perConnectorExecuteSchema.parse({
      prompt: JSON.stringify(request),
      model: 'jev-latest',
    });
    const result = await controller.executePerConnector('typesafe-jev', body, undefined, {
      apiKey: { id: 'fixture-key' },
    } as never);
    expect(result).toMatchObject({
      status: 'success',
      structured: { action: 'none', status: 'observed' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('provider READ-only gate blocks before transport', async () => {
    vi.stubEnv('PROVIDER_ACCESS', 'typesafe-jev:read');
    expect(await stack().decisions.evaluate(request, 'fixture-key')).toMatchObject({
      status: 'unknown',
      answers: {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('per-key provider restriction blocks before transport', async () => {
    const { decisions } = stack({ policyVersion: 1, providers: ['openrouter'] });
    expect((await decisions.evaluate(request, 'fixture-key')).status).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('free-only key cannot silently treat an unpriced model as free', async () => {
    const { decisions } = stack({ policyVersion: 1, models: { mode: 'free-only' } });
    expect((await decisions.evaluate(request, 'fixture-key')).status).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not compound retries or invent a decision on provider failure', async () => {
    fetchMock.mockResolvedValue(new Response('synthetic error', { status: 503 }));
    expect(await stack().decisions.evaluate(request, 'fixture-key')).toMatchObject({
      status: 'unknown',
      action: 'none',
      answers: {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects missing identity before entering the choke point', async () => {
    await expect(stack().decisions.evaluate(request, '')).rejects.toThrow(
      'Invalid decision request',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('resolves mandatory service dependency through Nest injection metadata', async () => {
    const connectors = { execute: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [DecisionService, { provide: ConnectorsService, useValue: connectors }],
    }).compile();
    expect(module.get(DecisionService)).toBeInstanceOf(DecisionService);
    await module.close();
  });
});
