import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { PerplexityConnector } from './perplexity.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [PerplexityConnector],
})
export class PerplexityModule implements OnModuleInit {
  constructor(
    private readonly perplexity: PerplexityConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.perplexity);
  }
}
