import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StatsService, STATS_MAX_RESULT_ROWS } from './stats.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  $queryRaw: vi.fn(),
};

function fakeRow(overrides: Record<string, unknown> = {}) {
  return {
    connector: 'openrouter',
    model: 'gpt-oss-20b:free',
    day: new Date('2026-07-01T00:00:00.000Z'),
    requests: 10,
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    costUsd: 0.5,
    ...overrides,
  };
}

describe('StatsService', () => {
  let service: StatsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new StatsService(mockPrisma as unknown as PrismaService);
  });

  describe('getDailyRequests (aggregation correctness on mocked Prisma fixtures)', () => {
    it('returns the rows resolved by the parameterized $queryRaw call', async () => {
      const rows = [
        fakeRow(),
        fakeRow({
          connector: 'vertex',
          model: 'imagen-4',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        }),
      ];
      mockPrisma.$queryRaw.mockResolvedValue(rows);

      const result = await service.getDailyRequests('2026-07-01', '2026-07-02');

      expect(result).toEqual(rows);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('calls $queryRaw with a tagged-template invocation bounding the since/until window', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await service.getDailyRequests('2026-07-01', '2026-07-02');

      const [strings, ...values] = mockPrisma.$queryRaw.mock.calls[0];
      // A Prisma tagged-template call receives a TemplateStringsArray as the
      // first argument (an array with a `.raw` property), never a single
      // pre-built string.
      expect(Array.isArray(strings)).toBe(true);
      expect(strings).toHaveProperty('raw');
      // The since/until bounds and the row cap must be present as bound
      // parameters (not interpolated into the strings array).
      expect(values.some((v) => v instanceof Date)).toBe(true);
      expect(values).toContain(STATS_MAX_RESULT_ROWS);
    });

    it('returns an empty array when no rows fall in the window', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getDailyRequests('2026-01-01', '2026-01-02');

      expect(result).toEqual([]);
    });
  });

  describe('response row cap (threat T9 — MC aggregate-query DoS)', () => {
    it('caps the returned rows at STATS_MAX_RESULT_ROWS even if the DB layer returns more', async () => {
      const oversized = Array.from({ length: STATS_MAX_RESULT_ROWS + 250 }, (_, i) =>
        fakeRow({ model: `model-${i}` }),
      );
      mockPrisma.$queryRaw.mockResolvedValue(oversized);

      const result = await service.getDailyRequests('2026-01-01', '2026-04-02');

      expect(result.length).toBe(STATS_MAX_RESULT_ROWS);
    });

    it('does not slice when the row count is within the cap', async () => {
      const rows = [fakeRow(), fakeRow({ model: 'other' })];
      mockPrisma.$queryRaw.mockResolvedValue(rows);

      const result = await service.getDailyRequests('2026-01-01', '2026-01-02');

      expect(result).toEqual(rows);
    });
  });

  describe('raw-SQL safety (static source assertion)', () => {
    const source = readFileSync(join(__dirname, 'stats.service.ts'), 'utf-8');

    it('never uses $queryRawUnsafe', () => {
      expect(source).not.toMatch(/\$queryRawUnsafe/);
    });

    it('uses a Prisma tagged-template $queryRaw call (backtick immediately follows the call)', () => {
      expect(source).toMatch(/\$queryRaw[\w<>[\]| ]*`/);
    });

    it('does not build the SQL string via concatenation of the since/until inputs', () => {
      expect(source).not.toMatch(/\+\s*(since|until|sinceDate|untilDate)\b/);
      expect(source).not.toMatch(/\b(since|until|sinceDate|untilDate)\s*\+/);
    });

    it('documents the row cap with an inline comment', () => {
      expect(source.toLowerCase()).toMatch(/cap|limit/);
    });
  });
});
