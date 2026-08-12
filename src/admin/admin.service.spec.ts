import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdminService } from './admin.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  apiKey: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

// CONN-1674 — mutable config so tests can toggle SHOWCASE_KEY_IDS per case.
const cfg = vi.hoisted(() => ({
  value: { API_KEY_SALT_ROUNDS: 4, SHOWCASE_KEY_IDS: '' } as Record<string, unknown>,
}));
vi.mock('../config/env.schema', () => ({
  getConfig: () => cfg.value,
}));

describe('AdminService', () => {
  let service: AdminService;

  beforeEach(() => {
    vi.clearAllMocks();
    cfg.value = { API_KEY_SALT_ROUNDS: 4, SHOWCASE_KEY_IDS: '' };
    service = new AdminService(mockPrisma as unknown as PrismaService);
  });

  describe('createKey', () => {
    it('should create key with mc- prefix and return raw key', async () => {
      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'uuid-1',
        name: 'test-key',
        keyHash: 'hashed',
      });

      const result = await service.createKey('test-key');

      expect(result.id).toBe('uuid-1');
      expect(result.name).toBe('test-key');
      expect(result.key).toMatch(/^mc-[a-f0-9]{32}$/);
    });

    it('should store bcrypt hash that validates against raw key', async () => {
      let storedHash = '';
      mockPrisma.apiKey.create.mockImplementation(async ({ data }) => {
        storedHash = data.keyHash;
        return { id: 'uuid-1', name: data.name, keyHash: data.keyHash };
      });

      const result = await service.createKey('test-key');
      const isValid = await compare(result.key, storedHash);

      expect(isValid).toBe(true);
    });

    it('should use default rateLimit 60 when not specified', async () => {
      mockPrisma.apiKey.create.mockResolvedValue({ id: 'uuid-1', name: 'test' });

      await service.createKey('test');

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ rateLimit: 60 }) }),
      );
    });

    it('should use provided rateLimit', async () => {
      mockPrisma.apiKey.create.mockResolvedValue({ id: 'uuid-1', name: 'test' });

      await service.createKey('test', 120);

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ rateLimit: 120 }) }),
      );
    });
  });

  // ── CONN-1665 — per-key policy write path ──
  describe('createKey with policy', () => {
    it('persists the (pre-validated) policy JSON', async () => {
      mockPrisma.apiKey.create.mockResolvedValue({ id: 'uuid-1', name: 'test' });
      const policy = { policyVersion: 1 as const, models: { mode: 'free-only' as const } };

      await service.createKey('test', undefined, policy);

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ policy }) }),
      );
    });

    it('omits the policy field entirely when not provided', async () => {
      mockPrisma.apiKey.create.mockResolvedValue({ id: 'uuid-1', name: 'test' });

      await service.createKey('test');

      const data = mockPrisma.apiKey.create.mock.calls[0][0].data;
      expect('policy' in data).toBe(false);
    });
  });

  describe('setKeyPolicy', () => {
    const policy = { policyVersion: 1 as const, providers: ['openrouter'] };

    it('updates the policy and invalidates the PolicyService cache', async () => {
      const policyService = { invalidateKey: vi.fn() };
      const svc = new AdminService(mockPrisma as unknown as PrismaService, policyService as never);
      mockPrisma.apiKey.findUnique.mockResolvedValue({ id: 'uuid-1' });
      mockPrisma.apiKey.update.mockResolvedValue({ id: 'uuid-1' });

      await svc.setKeyPolicy('uuid-1', policy);

      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        data: { policy },
      });
      expect(policyService.invalidateKey).toHaveBeenCalledWith('uuid-1');
    });

    it('null clears the stored policy (DbNull)', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({ id: 'uuid-1' });
      mockPrisma.apiKey.update.mockResolvedValue({ id: 'uuid-1' });

      await service.setKeyPolicy('uuid-1', null);

      const data = mockPrisma.apiKey.update.mock.calls[0][0].data;
      // Prisma.DbNull sentinel — anything but a plain null/undefined pass-through.
      expect(data.policy).not.toBeNull();
      expect(data.policy).toBeDefined();
    });

    it('throws NotFoundException for a non-existent key', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);
      await expect(service.setKeyPolicy('missing', policy)).rejects.toThrow(NotFoundException);
    });
  });

  // ── CONN-1674 — showcase-key narrowing guard (NEGATIVE CONTROL) ──
  // This suite is the negative control the task demands: it MUST fail if the
  // guard is removed. A read-only showcase key backing the public catalog page
  // must reject any narrowing policy (the exact free-only that collapsed the
  // arcanada.ai catalog 998→33 under CONN-1669).
  describe('setKeyPolicy — showcase-key guard (CONN-1674)', () => {
    const showcaseId = 'show-1';
    beforeEach(() => {
      cfg.value = { API_KEY_SALT_ROUNDS: 4, SHOWCASE_KEY_IDS: 'show-1, show-2' };
      mockPrisma.apiKey.findUnique.mockResolvedValue({ id: showcaseId });
      mockPrisma.apiKey.update.mockResolvedValue({ id: showcaseId });
    });

    it('REJECTS free-only on a showcase key (the CONN-1669 regression)', async () => {
      const freeOnly = { policyVersion: 1 as const, models: { mode: 'free-only' as const } };
      await expect(service.setKeyPolicy(showcaseId, freeOnly)).rejects.toThrow(BadRequestException);
      expect(mockPrisma.apiKey.update).not.toHaveBeenCalled();
    });

    it('REJECTS a provider-subset policy on a showcase key', async () => {
      const subset = { policyVersion: 1 as const, providers: ['openrouter'] };
      await expect(service.setKeyPolicy(showcaseId, subset)).rejects.toThrow(BadRequestException);
      expect(mockPrisma.apiKey.update).not.toHaveBeenCalled();
    });

    it('REJECTS a list restriction on a showcase key', async () => {
      const list = {
        policyVersion: 1 as const,
        models: { mode: 'list' as const, list: ['gpt-x'] },
      };
      await expect(service.setKeyPolicy(showcaseId, list)).rejects.toThrow(BadRequestException);
    });

    it('ALLOWS clearing the policy (null) on a showcase key', async () => {
      await expect(service.setKeyPolicy(showcaseId, null)).resolves.toEqual({ id: showcaseId });
      expect(mockPrisma.apiKey.update).toHaveBeenCalled();
    });

    it("ALLOWS a bare {policyVersion:1} (models.mode 'all') on a showcase key", async () => {
      const unrestricted = { policyVersion: 1 as const, models: { mode: 'all' as const } };
      await expect(service.setKeyPolicy(showcaseId, unrestricted)).resolves.toEqual({
        id: showcaseId,
      });
      expect(mockPrisma.apiKey.update).toHaveBeenCalled();
    });

    it('does NOT guard a non-showcase key (free-only still allowed there)', async () => {
      const freeOnly = { policyVersion: 1 as const, models: { mode: 'free-only' as const } };
      mockPrisma.apiKey.findUnique.mockResolvedValue({ id: 'other' });
      mockPrisma.apiKey.update.mockResolvedValue({ id: 'other' });
      await expect(service.setKeyPolicy('other', freeOnly)).resolves.toEqual({ id: 'other' });
      expect(mockPrisma.apiKey.update).toHaveBeenCalled();
    });
  });

  describe('listKeys', () => {
    it('should return keys without hash, sorted by createdAt desc', async () => {
      const keys = [
        { id: '1', name: 'key-a', rateLimit: 60, active: true, createdAt: new Date() },
        { id: '2', name: 'key-b', rateLimit: 100, active: false, createdAt: new Date() },
      ];
      mockPrisma.apiKey.findMany.mockResolvedValue(keys);

      const result = await service.listKeys();

      expect(result).toEqual(keys);
      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith({
        select: { id: true, name: true, rateLimit: true, active: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('revokeKey', () => {
    it('should set active=false for existing key', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({ id: 'uuid-1', active: true });
      mockPrisma.apiKey.update.mockResolvedValue({ id: 'uuid-1', active: false });

      await service.revokeKey('uuid-1');

      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        data: { active: false },
      });
    });

    it('should throw NotFoundException for non-existent key', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(service.revokeKey('non-existent')).rejects.toThrow(NotFoundException);
    });
  });
});
