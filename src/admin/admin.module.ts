import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CircuitBreakerAdminController } from './circuit-breaker.controller';
import { ConnectorsModule } from '../connectors/connectors.module';
import { WatcherRepairController } from './watcher-repair.controller';
import { WatcherRepairGuard } from './watcher-repair.guard';
// CONN-1665 — shared PolicyService singleton (write path invalidates the read cache).
import { PolicyModule } from '../policy/policy.module';
// CONN-1668 — shared AuthService singleton so create/revoke flush its verify cache.
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ConnectorsModule, PolicyModule, AuthModule],
  controllers: [AdminController, CircuitBreakerAdminController, WatcherRepairController],
  providers: [AdminService, WatcherRepairGuard],
})
export class AdminModule {}
