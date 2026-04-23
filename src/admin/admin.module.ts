import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CircuitBreakerAdminController } from './circuit-breaker.controller';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [ConnectorsModule],
  controllers: [AdminController, CircuitBreakerAdminController],
  providers: [AdminService],
})
export class AdminModule {}
