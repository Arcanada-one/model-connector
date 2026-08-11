// CONN-0243 — OpenAI-compatible failover gateway module.
//
// Imports ConnectorsModule (which exports ConnectorsService) and provides the
// FailoverRouterService + OpenAiCompatController. Imported by AppModule. The
// dependency is one-directional (connectors → NOT failover), so no forwardRef
// cycle is needed here, unlike CascadeModule which connectors.module imports for
// the shared controller (consilium R-F6).

import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { FailoverRouterService } from '../connectors/failover/failover-router.service';
import { OpenAiCompatController } from './openai-compat.controller';

@Module({
  imports: [ConnectorsModule],
  controllers: [OpenAiCompatController],
  providers: [FailoverRouterService],
  exports: [FailoverRouterService],
})
export class OpenAiCompatModule {}
