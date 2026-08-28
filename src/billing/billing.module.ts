import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { BillingService } from './billing.service';

/**
 * Global so the connector path can charge without threading the service
 * through every intermediate module.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
