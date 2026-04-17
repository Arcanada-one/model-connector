import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthGuard } from './auth.guard';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  const mockAuthService = { validateKey: vi.fn() };
  const mockReflector = { getAllAndOverride: vi.fn() };

  const createContext = (authorization?: string) => ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { authorization },
      }),
    }),
  });

  beforeEach(() => {
    guard = new AuthGuard(mockAuthService as any, mockReflector as unknown as Reflector);
    vi.clearAllMocks();
  });

  it('should allow public routes', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(true);
    const result = await guard.canActivate(createContext() as any);
    expect(result).toBe(true);
  });

  it('should reject missing token', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
    await expect(guard.canActivate(createContext() as any)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject invalid token', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
    mockAuthService.validateKey.mockResolvedValue(null);
    await expect(guard.canActivate(createContext('Bearer bad-key') as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
