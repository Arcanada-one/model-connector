import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { AnthropicConnector } from './anthropic.connector';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [AnthropicConnector],
})
export class AnthropicModule implements OnModuleInit {
  constructor(
    private readonly anthropic: AnthropicConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.anthropic);
  }
}
