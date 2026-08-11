import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { CerebrasConnector } from './cerebras.connector';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [CerebrasConnector],
})
export class CerebrasModule implements OnModuleInit {
  constructor(
    private readonly cerebras: CerebrasConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.cerebras);
  }
}
