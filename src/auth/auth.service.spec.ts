import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.service';
import { hash } from 'bcryptjs';

describe('AuthService', () => {
  let service: AuthService;
  const mockPrisma = {
    apiKey: {
      findMany: vi.fn(),
    },
  };

  beforeEach(() => {
    service = new AuthService(mockPrisma as any);
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
});
