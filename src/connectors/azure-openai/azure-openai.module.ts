import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { AzureOpenAiConnector } from './azure-openai.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [AzureOpenAiConnector],
})
export class AzureOpenAiModule implements OnModuleInit {
  constructor(
    private readonly connector: AzureOpenAiConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.connector);
  }
}
