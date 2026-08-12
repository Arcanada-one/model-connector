import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { hash } from 'bcryptjs';

describe('AuthService', () => {
  let service: AuthService;
  const mockPrisma = {
    apiKey: {
      findMany: vi.fn(),
    },
  };

  beforeEach(() => {
    service = new AuthService(mockPrisma as unknown as PrismaService);
    vi.clearAllMocks();
  });

  it('should return key info for valid key', async () => {
    const rawKey = 'test-api-key-123';
    const keyHash = await hash(rawKey, 10);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      { id: 'key-1', name: 'test-key', keyHash, active: true },
    ]);

    const result = await service.validateKey(rawKey);
    expect(result).toEqual({ id: 'key-1', name: 'test-key' });
  });

  it('should return null for invalid key', async () => {
    const keyHash = await hash('correct-key', 10);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      { id: 'key-1', name: 'test', keyHash, active: true },
    ]);

    const result = await service.validateKey('wrong-key');
    expect(result).toBeNull();
  });

  it('should return null when no keys exist', async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([]);
    const result = await service.validateKey('any-key');
    expect(result).toBeNull();
  });

  // CONN-1668: validateKey ran an O(N) bcryptjs sweep on the event loop for
  // EVERY authenticated request (measured ~1.4s/request at 69 keys on prod).
  // The verify cache must collapse repeats to a single sweep. These are the
  // mutation target: removing the cache makes the findMany call-count fail.
  describe('verify cache (CONN-1668)', () => {
    it('verifies once, then serves repeats from the cache (no bcrypt sweep)', async () => {
      const rawKey = 'cache-key-1';
      const keyHash = await hash(rawKey, 10);
      mockPrisma.apiKey.findMany.mockResolvedValue([
        { id: 'key-1', name: 'agent', keyHash, active: true },
      ]);

      expect(await service.validateKey(rawKey)).toEqual({ id: 'key-1', name: 'agent' });
      expect(await service.validateKey(rawKey)).toEqual({ id: 'key-1', name: 'agent' });
      expect(await service.validateKey(rawKey)).toEqual({ id: 'key-1', name: 'agent' });
      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledTimes(1);
    });

    it('caches a failed verification briefly (a bad key cannot force a sweep per request)', async () => {
      const keyHash = await hash('correct', 10);
      mockPrisma.apiKey.findMany.mockResolvedValue([
        { id: 'key-1', name: 'agent', keyHash, active: true },
      ]);

      expect(await service.validateKey('wrong')).toBeNull();
      expect(await service.validateKey('wrong')).toBeNull();
      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledTimes(1);
    });

    it('flushVerifyCache forces a re-read so a revoked key stops validating', async () => {
      const rawKey = 'cache-key-2';
      const keyHash = await hash(rawKey, 10);
      mockPrisma.apiKey.findMany.mockResolvedValue([
        { id: 'key-1', name: 'agent', keyHash, active: true },
      ]);

      expect(await service.validateKey(rawKey)).toEqual({ id: 'key-1', name: 'agent' });
      // Key revoked in the DB → no longer active.
      mockPrisma.apiKey.findMany.mockResolvedValue([]);
      service.flushVerifyCache();
      expect(await service.validateKey(rawKey)).toBeNull();
      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledTimes(2);
    });
  });
});
