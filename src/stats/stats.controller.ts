import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { StatsReadGuard } from './stats-read.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { statsDailyQuerySchema, StatsDailyQueryDto } from './dto';
import { StatsService, StatsDailyRow } from './stats.service';

// CTRL-0026 Phase 2 — read-only stats seam for Control Arcana's BFF
// provider-accounts collector. Guarded by StatsReadGuard ONLY — never
// AdminGuard, never the inference ApiKey guard (see stats-read.guard.ts).
@Controller('stats')
@UseGuards(StatsReadGuard)
@Public()
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('requests/daily')
  async getDailyRequests(
    @Query(new ZodValidationPipe(statsDailyQuerySchema)) query: StatsDailyQueryDto,
  ): Promise<StatsDailyRow[]> {
    return this.statsService.getDailyRequests(query.since, query.until);
  }
}
