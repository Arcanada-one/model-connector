import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { DecisionsController } from './decisions.controller';
import { DecisionsRouteService } from './decisions.service';

@Module({
  imports: [ConnectorsModule],
  controllers: [DecisionsController],
  providers: [DecisionsRouteService],
  exports: [DecisionsRouteService],
})
export class DecisionsModule {}
