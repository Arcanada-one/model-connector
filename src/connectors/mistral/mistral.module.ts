import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { MistralConnector } from './mistral.connector';

@Module({ imports: [forwardRef(() => ConnectorsModule)], providers: [MistralConnector] })
export class MistralModule implements OnModuleInit {
  constructor(
    private readonly mistral: MistralConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}
  onModuleInit(): void {
    this.connectors.register(this.mistral);
    void this.mistral.refreshModels();
  }
}
