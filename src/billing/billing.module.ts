import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { BillingService } from './billing.service';
import { BillingReconcilerService } from './reconciler.service';
import { CreditsController } from './credits.controller';
import { PaymentsController } from './payments.controller';
import { PolicyModule } from '../policy/policy.module';
import { ProfileSpendEventsController } from './profile-spend/events.controller';
import { ProfileSpendEventsService } from './profile-spend/events.service';

/**
 * Global so the connector path can charge without threading the service
 * through every intermediate module.
 */
@Global()
@Module({
  imports: [PrismaModule, PolicyModule],
  controllers: [CreditsController, PaymentsController, ProfileSpendEventsController],
  providers: [BillingService, BillingReconcilerService, ProfileSpendEventsService],
  exports: [BillingService, BillingReconcilerService],
})
export class BillingModule {}
