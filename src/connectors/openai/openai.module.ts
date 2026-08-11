import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { OpenAiConnector } from './openai.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [OpenAiConnector],
})
export class OpenAiModule implements OnModuleInit {
  constructor(
    private readonly openai: OpenAiConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.openai);
    void this.openai.refreshModels();
  }
}
