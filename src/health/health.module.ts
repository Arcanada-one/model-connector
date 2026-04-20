import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [ConnectorsModule],
  controllers: [HealthController],
})
export class HealthModule {}
