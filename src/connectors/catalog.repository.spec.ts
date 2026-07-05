import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CatalogRepository, type ModelCatalogUpsert } from './catalog.repository';
import { PrismaService } from '../prisma/prisma.service';

describe('CatalogRepository (CONN-0245)', () => {
  let mockPrisma: {
    modelCatalog: {
      upsert: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let repo: CatalogRepository;

  const row: ModelCatalogUpsert = {
    connector: 'groq',
    model: 'llama-3.3-70b-versatile',
    modality: 'chat',
    status: 'online',
    lastChecked: new Date('2026-07-05T16:00:00.000Z'),
    supportsStreaming: false,
    supportsJsonSchema: true,
    supportsTools: true,
    inputPerMTok: 0,
    outputPerMTok: 0,
    priceUnit: 'USD/1M tokens',
    tier: 'free',
    free: true,
    priceMultiplier: 0,
    contextWindow: 131072,
    maxOutputTokens: 32768,
    endpoint: null,
    executableHere: true,
    routable: true,
  };

  beforeEach(() => {
    mockPrisma = {
      modelCatalog: {
        upsert: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    repo = new CatalogRepository(mockPrisma as unknown as PrismaService);
  });

  describe('upsertSnapshot', () => {
    it('upserts each row by (connector, model), preserving firstSeen on update (create-only)', async () => {
      await repo.upsertSnapshot([row]);
      expect(mockPrisma.modelCatalog.upsert).toHaveBeenCalledTimes(1);
      const call = mockPrisma.modelCatalog.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        connector_model: { connector: 'groq', model: 'llama-3.3-70b-versatile' },
      });
      // firstSeen is set on `create` only — never present in the `update` payload,
      // so an existing row's firstSeen is never overwritten by a later refresh.
      expect(call.create).toMatchObject({ ...row, absent: false });
      expect(call.create.firstSeen).toBeInstanceOf(Date);
      expect(call.update).toMatchObject({ ...row, absent: false });
      expect(call.update.firstSeen).toBeUndefined();
      expect(call.update.lastSeen).toBeInstanceOf(Date);
    });

    it('upserts multiple rows independently', async () => {
      await repo.upsertSnapshot([row, { ...row, model: 'other-model' }]);
      expect(mockPrisma.modelCatalog.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('markAbsentExcept', () => {
    it('marks rows NOT in the seen set absent=true, keeping the rows (no delete)', async () => {
      await repo.markAbsentExcept([{ connector: 'groq', model: 'llama-3.3-70b-versatile' }]);
      expect(mockPrisma.modelCatalog.updateMany).toHaveBeenCalledTimes(1);
      const call = mockPrisma.modelCatalog.updateMany.mock.calls[0][0];
      expect(call.data).toEqual({ absent: true });
      // Never a delete call — this repo has no `delete`/`deleteMany` method.
      expect((mockPrisma.modelCatalog as Record<string, unknown>).delete).toBeUndefined();
      expect((mockPrisma.modelCatalog as Record<string, unknown>).deleteMany).toBeUndefined();
    });

    it('marks everything absent when the seen set is empty (provider list totally empty this cycle)', async () => {
      await repo.markAbsentExcept([]);
      expect(mockPrisma.modelCatalog.updateMany).toHaveBeenCalledWith({
        where: { absent: false },
        data: { absent: true },
      });
    });
  });

  describe('updateProviderStatus', () => {
    it('updates ONLY status + lastChecked for the connector, never pricing/caps', async () => {
      const lastChecked = new Date('2026-07-05T16:05:00.000Z');
      await repo.updateProviderStatus('groq', 'offline', lastChecked);
      expect(mockPrisma.modelCatalog.updateMany).toHaveBeenCalledWith({
        where: { connector: 'groq' },
        data: { status: 'offline', lastChecked },
      });
    });
  });

  describe('findAll', () => {
    it('excludes absent rows from the live catalog read path', async () => {
      await repo.findAll();
      expect(mockPrisma.modelCatalog.findMany).toHaveBeenCalledWith({
        where: { absent: false },
      });
    });

    it('returns whatever prisma returns', async () => {
      mockPrisma.modelCatalog.findMany.mockResolvedValue([{ ...row, id: 'x' }]);
      const result = await repo.findAll();
      expect(result).toEqual([{ ...row, id: 'x' }]);
    });
  });
});
