import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';
import { ModalConnector } from './modal.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [ModalConnector],
})
export class ModalModule implements OnModuleInit {
  constructor(
    private readonly connector: ModalConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    if (!process.env.MODAL_ENDPOINT_URL) return;
    this.connectors.register(this.connector);
    void this.connector.refreshModels();
  }
}
