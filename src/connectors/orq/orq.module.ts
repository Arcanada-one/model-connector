// CONN-0239 — orq.ai connector NestJS module.
// Registers OrqConnector with ConnectorsService and kicks off model discovery on boot.
import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { OrqConnector } from './orq.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [OrqConnector],
})
export class OrqModule implements OnModuleInit {
  constructor(
    private readonly orq: OrqConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.orq);
    // Fire-and-forget: discover ~421 chat models from /v2/models.
    // refreshModels() tolerates all failure modes; catalog works with seed list
    // if the API is unreachable at boot.
    void this.orq.refreshModels();
  }
}
