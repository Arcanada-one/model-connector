import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderAccessService } from './provider-access.service';
import { PrismaService } from '../prisma/prisma.service';

// CONN-0245-EXT — control PROVIDER_ACCESS (CONN-0244's config contract) per test.
vi.mock('../config/env.schema', () => ({
  getConfig: vi.fn(() => ({ PROVIDER_ACCESS: 'openmodel:read' })),
}));
import { getConfig } from '../config/env.schema';

describe('ProviderAccessService (CONN-0245-EXT — DB state feeding CONN-0244 config)', () => {
  let mockPrisma: {
    providerAccess: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let service: ProviderAccessService;

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({
      PROVIDER_ACCESS: 'openmodel:read',
    } as ReturnType<typeof getConfig>);
    mockPrisma = {
      providerAccess: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    service = new ProviderAccessService(mockPrisma as unknown as PrismaService);
  });

  describe('getAccess — before any seed/refresh (fresh boot)', () => {
    it('falls through to the CONN-0244 config default (openmodel:read)', () => {
      expect(service.getAccess('openmodel')).toEqual({ read: true, use: false });
    });

    it('falls through to fully-enabled for a provider not in PROVIDER_ACCESS', () => {
      expect(service.getAccess('groq')).toEqual({ read: true, use: true });
    });
  });

  describe('seedDefaults', () => {
    it('create-only: does NOT overwrite a provider row that already exists', async () => {
      mockPrisma.providerAccess.findUnique.mockResolvedValue({
        provider: 'groq',
        readEnabled: false, // operator already flipped this — must survive
        useEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await service.seedDefaults(['groq']);
      expect(mockPrisma.providerAccess.create).not.toHaveBeenCalled();
    });

    it('creates a row derived from PROVIDER_ACCESS for a genuinely new provider (openmodel:read)', async () => {
      mockPrisma.providerAccess.findUnique.mockResolvedValue(null);
      await service.seedDefaults(['openmodel']);
      expect(mockPrisma.providerAccess.create).toHaveBeenCalledWith({
        data: { provider: 'openmodel', readEnabled: true, useEnabled: false },
      });
    });

    it('a provider not listed in PROVIDER_ACCESS seeds fully-enabled', async () => {
      mockPrisma.providerAccess.findUnique.mockResolvedValue(null);
      await service.seedDefaults(['groq']);
      expect(mockPrisma.providerAccess.create).toHaveBeenCalledWith({
        data: { provider: 'groq', readEnabled: true, useEnabled: true },
      });
    });

    it('seeds providers named in PROVIDER_ACCESS even if not (yet) a registered connector', async () => {
      vi.mocked(getConfig).mockReturnValue({
        PROVIDER_ACCESS: 'openmodel:read,retired-provider:none',
      } as ReturnType<typeof getConfig>);
      mockPrisma.providerAccess.findUnique.mockResolvedValue(null);
      await service.seedDefaults(['groq']); // registered connectors: only groq
      expect(mockPrisma.providerAccess.create).toHaveBeenCalledTimes(3);
      expect(mockPrisma.providerAccess.create).toHaveBeenCalledWith({
        data: { provider: 'retired-provider', readEnabled: false, useEnabled: false },
      });
    });

    it('refreshes the cache after seeding — getAccess reflects the DB row immediately', async () => {
      mockPrisma.providerAccess.findUnique.mockResolvedValue(null);
      mockPrisma.providerAccess.findMany.mockResolvedValue([
        { provider: 'openmodel', readEnabled: true, useEnabled: false },
      ]);
      await service.seedDefaults(['openmodel']);
      expect(mockPrisma.providerAccess.findMany).toHaveBeenCalledTimes(1);
      expect(service.getAccess('openmodel')).toEqual({ read: true, use: false });
    });
  });

  describe('refresh / cache', () => {
    it('refresh(true) always reloads from the DB', async () => {
      mockPrisma.providerAccess.findMany.mockResolvedValue([]);
      await service.refresh(true);
      await service.refresh(true);
      expect(mockPrisma.providerAccess.findMany).toHaveBeenCalledTimes(2);
    });

    it('refresh() without force is debounced — a second call shortly after does not re-query', async () => {
      mockPrisma.providerAccess.findMany.mockResolvedValue([]);
      await service.refresh();
      await service.refresh();
      expect(mockPrisma.providerAccess.findMany).toHaveBeenCalledTimes(1);
    });

    it('getAccess returns the cached DB row once refreshed, overriding the config default', async () => {
      // Config says openmodel:read (use=false); operator flips it to fully-usable in the DB.
      mockPrisma.providerAccess.findMany.mockResolvedValue([
        { provider: 'openmodel', readEnabled: true, useEnabled: true },
      ]);
      await service.refresh(true);
      expect(service.getAccess('openmodel')).toEqual({ read: true, use: true });
    });

    it('a provider absent from the DB cache still falls through to config (not fully-enabled by default)', async () => {
      mockPrisma.providerAccess.findMany.mockResolvedValue([
        { provider: 'groq', readEnabled: true, useEnabled: true },
      ]);
      await service.refresh(true);
      // openmodel has no DB row (never seeded in this test) — falls through
      // to PROVIDER_ACCESS config ('openmodel:read'), NOT a blanket true.
      expect(service.getAccess('openmodel')).toEqual({ read: true, use: false });
    });
  });
});
