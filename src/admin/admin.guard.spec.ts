import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminGuard } from './admin.guard';
import { ExecutionContext } from '@nestjs/common';

function createMockContext(headers: Record<string, string | string[]> = {}): ExecutionContext {
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

  /**
   * ARAS-0058 (consilium §6.2) — the byte-length crash-oracle.
   *
   * This test FAILS on the pre-fix guard, which is the point of it. That guard
   * compared `token.length !== expected.length` (UTF-16 code units) and then
   * `timingSafeEqual(Buffer.from(token), Buffer.from(expected))` (UTF-8 bytes).
   * 'é' is one code unit and two bytes, so this token passes the pre-check at
   * 32 characters and reaches `timingSafeEqual` as 33 bytes against 32 —
   * `RangeError: Input buffers must have the same byte length`.
   *
   * Nest turns that into a 500 while every other wrong token gets a 403. An
   * attacker who can tell those apart can binary-search the BYTE length of
   * `ADMIN_TOKEN` — which, on a route consilium §6.1 confirmed is world-
   * reachable and mints balance, is a real first step rather than a curiosity.
   */
  it('does not crash on a multi-byte token of equal string length (crash-oracle)', () => {
    const oracle = 'é' + 'a'.repeat(31);
    expect(oracle.length).toBe(VALID_TOKEN.length);
    expect(Buffer.byteLength(oracle, 'utf8')).not.toBe(Buffer.byteLength(VALID_TOKEN, 'utf8'));

    const ctx = createMockContext({ 'x-admin-token': oracle });
    // Denied, and denied the SAME WAY as any other wrong token: `false`, not a
    // thrown RangeError that becomes a distinguishable 500.
    expect(() => guard.canActivate(ctx)).not.toThrow();
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('denies a duplicated header rather than picking one', () => {
    // Fastify delivers a repeated header as an array. Taking the first element
    // would let a caller send two tokens and have the guard authenticate on
    // one while anything reading the header later sees the other.
    const ctx = createMockContext({ 'x-admin-token': [VALID_TOKEN, VALID_TOKEN] as never });
    expect(guard.canActivate(ctx)).toBe(false);
  });
});
