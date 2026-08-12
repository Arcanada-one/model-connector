// CONN-1665 — per-API-key access policy module. PrismaModule is @Global, so
// PolicyService's PrismaService dependency resolves without an explicit import.

import { Module } from '@nestjs/common';
import { PolicyService } from './policy.service';

@Module({
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
