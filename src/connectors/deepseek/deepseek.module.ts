import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { DeepSeekConnector } from './deepseek.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [DeepSeekConnector],
})
export class DeepSeekModule implements OnModuleInit {
  constructor(
    private readonly deepseek: DeepSeekConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.deepseek);
  }
}
