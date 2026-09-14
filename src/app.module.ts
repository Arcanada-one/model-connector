import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { BillingModule } from './billing/billing.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './auth/auth.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { AdminModule } from './admin/admin.module';
import { SpeechModule } from './speech/speech.module';
import { StatsModule } from './stats/stats.module';
import { OpenAiCompatModule } from './openai-compat/openai-compat.module';
import { PromptCacheModule } from './prompt-cache/prompt-cache.module';
import { PromptCachePrewarmModule } from './prompt-cache/prompt-cache-prewarm.module';
import { getConfig } from './config/env.schema';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    BillingModule,
    // CONN-0245 — enables @Cron/@Interval for CatalogRefreshService.
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: {
        host: getConfig().REDIS_HOST,
        port: getConfig().REDIS_PORT,
        ...(getConfig().REDIS_PASSWORD && { password: getConfig().REDIS_PASSWORD }),
      },
      prefix: getConfig().REDIS_PREFIX,
    }),
    AuthModule,
    ConnectorsModule,
    HealthModule,
    MetricsModule,
    AdminModule,
    SpeechModule,
    StatsModule,
    OpenAiCompatModule,
    // AUP-CACHE-006 — prompt-cache policy (admin surface) + pre-warm endpoint.
    PromptCacheModule,
    PromptCachePrewarmModule,
  ],
})
export class AppModule {}
