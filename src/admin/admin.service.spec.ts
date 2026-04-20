import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdminService } from './admin.service';
import { NotFoundException } from '@nestjs/common';
import { compare } from 'bcryptjs';

const mockPrisma = {
  apiKey: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('../config/env.schema', () => ({
  getConfig: () => ({ API_KEY_SALT_ROUNDS: 4 }),
}));

describe('AdminService', () => {
  let service: AdminService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AdminService(mockPrisma as any);
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
