import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminGuard } from './admin.guard';
import { ExecutionContext } from '@nestjs/common';

function createMockContext(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;
  const VALID_TOKEN = 'a'.repeat(32);

  beforeEach(() => {
    guard = new AdminGuard();
    process.env.ADMIN_TOKEN = VALID_TOKEN;
  });

  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it('should allow access with valid token', () => {
    const ctx = createMockContext({ 'x-admin-token': VALID_TOKEN });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should deny access with wrong token', () => {
    const ctx = createMockContext({ 'x-admin-token': 'b'.repeat(32) });
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('should deny access with missing token header', () => {
    const ctx = createMockContext({});
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('should deny access when ADMIN_TOKEN env is not set', () => {
    delete process.env.ADMIN_TOKEN;
    const ctx = createMockContext({ 'x-admin-token': VALID_TOKEN });
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('should deny access with token of different length', () => {
    const ctx = createMockContext({ 'x-admin-token': 'short' });
    expect(guard.canActivate(ctx)).toBe(false);
  });
});
