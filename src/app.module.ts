import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './auth/auth.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { getConfig } from './config/env.schema';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    BullModule.forRoot({
      connection: {
        host: getConfig().REDIS_HOST,
        port: getConfig().REDIS_PORT,
      },
      prefix: getConfig().REDIS_PREFIX,
    }),
    AuthModule,
    ConnectorsModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
