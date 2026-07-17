import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { StatsReadGuard } from './stats-read.guard';

// CTRL-0026 Phase 2 — read-only provider-accounts stats seam. PrismaService
// is provided globally by PrismaModule (src/prisma/prisma.module.ts), so no
// explicit import is needed here (matches HealthModule / AdminModule).
@Module({
  controllers: [StatsController],
  providers: [StatsService, StatsReadGuard],
})
export class StatsModule {}
