import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { OpenModelConnector } from './openmodel.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [OpenModelConnector],
})
export class OpenModelModule implements OnModuleInit {
  constructor(
    private readonly openmodel: OpenModelConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.openmodel);
    // CONN-0236 — fetch the live ~32-model list on startup (fire-and-forget,
    // like OpenRouter's refreshFreeModels). Failure leaves the static 3 in place.
    void this.openmodel.refreshModels();
  }
}
