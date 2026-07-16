import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatsReadGuard } from './stats-read.guard';
import { ExecutionContext, Logger } from '@nestjs/common';

function createMockContext(headers: Record<string, string | string[]> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('StatsReadGuard', () => {
  let guard: StatsReadGuard;
  const VALID_TOKEN = 'a'.repeat(32);

  beforeEach(() => {
    guard = new StatsReadGuard();
    process.env.STATS_READ_TOKEN = VALID_TOKEN;
  });

  afterEach(() => {
    delete process.env.STATS_READ_TOKEN;
    vi.restoreAllMocks();
  });

  // Cases mirrored from src/admin/admin.guard.spec.ts:1-51 (5 base cases).
  it('should allow access with valid token', () => {
    const ctx = createMockContext({ 'x-stats-token': VALID_TOKEN });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should deny access with wrong token', () => {
    const ctx = createMockContext({ 'x-stats-token': 'b'.repeat(32) });
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('should deny access with missing token header', () => {
    const ctx = createMockContext({});
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('should deny access when STATS_READ_TOKEN env is not set', () => {
    delete process.env.STATS_READ_TOKEN;
    const ctx = createMockContext({ 'x-stats-token': VALID_TOKEN });
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('should deny access with token of different length', () => {
    const ctx = createMockContext({ 'x-stats-token': 'short' });
    expect(guard.canActivate(ctx)).toBe(false);
  });

  // Additional cases beyond admin.guard.spec.ts (CTRL-0026 Phase 2 spec).
  it('should deny access when STATS_READ_TOKEN env is set to the empty string, without throwing', () => {
    process.env.STATS_READ_TOKEN = '';
    const ctx = createMockContext({ 'x-stats-token': VALID_TOKEN });
    expect(() => guard.canActivate(ctx)).not.toThrow();
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('should deny access when the header is delivered as a duplicate string[] (Fastify/Nest), never picking the first element', () => {
    const ctx = createMockContext({ 'x-stats-token': [VALID_TOKEN, VALID_TOKEN] });
    expect(() => guard.canActivate(ctx)).not.toThrow();
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('should emit exactly one redacted reason-code log line on failed auth, containing no header/token content', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const ctx = createMockContext({ 'x-stats-token': 'b'.repeat(32) });

    guard.canActivate(ctx);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logLine] = warnSpy.mock.calls[0];
    expect(String(logLine)).not.toContain(VALID_TOKEN);
    expect(String(logLine)).not.toContain('b'.repeat(32));
    expect(String(logLine)).toMatch(/reason=/);
  });

  it('should NOT log on a successful auth attempt', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const ctx = createMockContext({ 'x-stats-token': VALID_TOKEN });

    guard.canActivate(ctx);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
