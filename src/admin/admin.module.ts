import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CircuitBreakerAdminController } from './circuit-breaker.controller';
import { ConnectorsModule } from '../connectors/connectors.module';
import { WatcherRepairController } from './watcher-repair.controller';
import { WatcherRepairGuard } from './watcher-repair.guard';

@Module({
  imports: [ConnectorsModule],
  controllers: [AdminController, CircuitBreakerAdminController, WatcherRepairController],
  providers: [AdminService, WatcherRepairGuard],
})
export class AdminModule {}
