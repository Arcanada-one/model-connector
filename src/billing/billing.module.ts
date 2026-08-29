import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { BillingService } from './billing.service';
import { BillingReconcilerService } from './reconciler.service';
import { CreditsController } from './credits.controller';
import { PaymentsController } from './payments.controller';

/**
 * Global so the connector path can charge without threading the service
 * through every intermediate module.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [CreditsController, PaymentsController],
  providers: [BillingService, BillingReconcilerService],
  exports: [BillingService, BillingReconcilerService],
})
export class BillingModule {}
