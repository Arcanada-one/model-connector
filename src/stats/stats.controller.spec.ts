import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { BadRequestException } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { StatsReadGuard } from './stats-read.guard';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { statsDailyQuerySchema } from './dto';

const mockStatsService = {
  getDailyRequests: vi.fn(),
};

describe('StatsController', () => {
  let controller: StatsController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new StatsController(mockStatsService as unknown as StatsService);
  });

  describe('guard wiring (route must be unreachable without StatsReadGuard)', () => {
    it('applies StatsReadGuard at the class level', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, StatsController);
      expect(guards).toBeDefined();
      expect(guards).toContain(StatsReadGuard);
    });

    it('does NOT apply AdminGuard or any inference ApiKey guard', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, StatsController) ?? [];
      const guardNames = guards.map((g: { name: string }) => g.name);
      expect(guardNames).not.toContain('AdminGuard');
      expect(guardNames).not.toContain('ApiKeyGuard');
    });

    it('is marked @Public (bypasses the global auth guard, relying solely on StatsReadGuard)', () => {
      const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, StatsController);
      expect(isPublic).toBe(true);
    });
  });

  describe('GET /stats/requests/daily — DTO validation via ZodValidationPipe', () => {
    const pipe = new ZodValidationPipe(statsDailyQuerySchema);

    it('accepts a valid window and returns the parsed DTO', () => {
      const result = pipe.transform({ since: '2026-06-01', until: '2026-06-02' });
      expect(result).toEqual({ since: '2026-06-01', until: '2026-06-02' });
    });

    it('rejects a malformed since date with BadRequestException', () => {
      expect(() => pipe.transform({ since: 'not-a-date', until: '2026-06-02' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects a malformed until date with BadRequestException', () => {
      expect(() => pipe.transform({ since: '2026-06-01', until: '06/02/2026' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects an overflowed calendar date (e.g. 2026-02-30) with BadRequestException', () => {
      expect(() => pipe.transform({ since: '2026-02-30', until: '2026-03-01' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects until < since with BadRequestException', () => {
      expect(() => pipe.transform({ since: '2026-06-10', until: '2026-06-01' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects a window wider than 92 days with BadRequestException', () => {
      expect(
        () => pipe.transform({ since: '2026-01-01', until: '2026-04-15' }), // 104 days
      ).toThrow(BadRequestException);
    });

    it('accepts a window of exactly 92 days', () => {
      const result = pipe.transform({ since: '2026-01-01', until: '2026-04-03' }); // 92 days
      expect(result).toEqual({ since: '2026-01-01', until: '2026-04-03' });
    });

    it('rejects a missing since field with BadRequestException', () => {
      expect(() => pipe.transform({ until: '2026-06-02' })).toThrow(BadRequestException);
    });
  });

  describe('getDailyRequests handler', () => {
    it('delegates to StatsService.getDailyRequests with the validated since/until', async () => {
      const rows = [
        {
          connector: 'openrouter',
          model: 'gpt-oss-20b:free',
          day: new Date('2026-06-01T00:00:00.000Z'),
          requests: 5,
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          costUsd: 0.1,
        },
      ];
      mockStatsService.getDailyRequests.mockResolvedValue(rows);

      const result = await controller.getDailyRequests({
        since: '2026-06-01',
        until: '2026-06-02',
      });

      expect(mockStatsService.getDailyRequests).toHaveBeenCalledWith('2026-06-01', '2026-06-02');
      expect(result).toEqual(rows);
    });
  });
});
